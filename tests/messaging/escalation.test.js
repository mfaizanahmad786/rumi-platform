/**
 * Rumi reporting its own failures to the people who can fix them.
 *
 * The behaviour this replaces, observed live: a teacher wrote "I asked you
 * for a lesson plan twice and both times it just stopped… nothing ever came",
 * intent detection classified it 'general', and the LLM apologised and
 * promised "Moving forward, I will always deliver your full lesson plan right
 * away in the very same message so you never have to wait" — a change Rumi
 * has no ability to make. The report reached nobody who could fix it.
 *
 * Two stages are tested separately because they fail differently: the regex
 * gate is generous by design and a false positive there is cheap, while the
 * classifier is where precision has to live.
 */

const { evaluateEscalationTrigger } = require('../../bot/shared/handlers/escalation-trigger');

jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));

describe('escalation trigger — the cheap gate', () => {
  const on = (messageBody) => evaluateEscalationTrigger({ messageBody, escalationConfigured: true });

  it('promotes the real report that started all this', () => {
    expect(on('I asked you for a lesson plan twice and both times it just stopped. '
      + 'You said you were preparing it and then nothing ever came.').match).toBe(true);
  });

  it.each([
    ['nothing arrived', 'I waited for the plan and nothing ever came'],
    ['it is stuck', 'the reading assessment has been stuck for ten minutes'],
    ['an error', 'it gave me an error when I sent the voice note'],
    ['wrong language', 'you replied in the wrong language again, I write in Urdu'],
    ['repetition', 'this keeps happening every time I ask you for a plan'],
    ['urdu', 'یہ کام نہیں کر رہا، دوبارہ کوشش کی لیکن کچھ نہیں آیا'],
  ])('promotes: %s', (_label, text) => {
    expect(on(text).match).toBe(true);
  });

  it('does NOT promote a teaching problem, which is what Rumi is FOR', () => {
    // The distinction that matters most: escalating this to engineers would
    // be useless and faintly insulting.
    expect(on('my students keep getting fractions wrong every time').match).toBe(false);
    expect(on('the children did not do their homework again').match).toBe(false);
  });

  it('DOES promote a complaint that names Rumi even if it mentions students', () => {
    expect(on('your lesson plan confused my students, the steps did not work').match).toBe(true);
  });

  it.each([
    ['ordinary chat', 'can you make me a lesson plan on fractions for grade 3'],
    ['too short', 'it broke'],
    ['no signal at all', 'thank you so much, this was really helpful today'],
  ])('does not promote: %s', (_label, text) => {
    expect(on(text).match).toBe(false);
  });

  it.each([
    ['I wish there was a /help command', 'request'],
    ['could you add Sindhi to the languages?', 'request'],
    ['it would help if I could download it as Word', 'request'],
  ])('promotes a request: %s', (text, suspected) => {
    const d = on(text);
    expect(d.match).toBe(true);
    expect(d.suspected).toBe(suspected);
  });

  // The gate was built from textbook phrasings — `it would help if`,
  // `would be great` — and nobody writes that way. One adverb defeated it, in
  // the exact sentence the feature exists to catch:
  //
  //   "it would really help If i typed /help and see what you can do."
  //
  // The gate returned no_signal, the classifier never ran, and the LLM replied
  // with a cheerful list of things Rumi can already do. The ask died in the
  // chat — the precise failure this path was written to end.
  it.each([
    ['the sentence that was missed live', 'it would really help If i typed /help and see what you can do.'],
    ['an adverb inside the phrase', "it'd really help to have a way to see every command"],
    ['stacked adverbs', 'it would just really help if you remembered my grade'],
    ['a comparative, not the plain form', 'would be so much nicer if it remembered my grade level'],
    ['the command named with its slash', 'please add a /help command'],
    ['a gap stated flatly, not as a wish', 'there is no way to see what you can do'],
  ])('promotes a request despite ordinary English: %s', (_label, text) => {
    const d = on(text);
    expect(d.match).toBe(true);
    expect(d.suspected).toBe('request');
  });

  it('still leaves ordinary requests alone after loosening the phrasing', () => {
    // Loosening the gate is only safe while these stay out: each would put a
    // classifier call on a large share of everything a teacher writes.
    for (const text of [
      'I would like a lesson plan about fractions',
      'would you help me plan tomorrow morning',
      'can you make me a lesson plan on photosynthesis for grade 5',
      'thanks, that was really helpful',
    ]) expect(on(text).match).toBe(false);
  });

  it('does NOT promote the most common thing a teacher says', () => {
    // "can you make me X" is ordinary use of a feature that works. Matching it
    // would put a classifier call on nearly every lesson-plan request.
    expect(on('can you make me a lesson plan on fractions for grade 3').match).toBe(false);
    expect(on('could you make a quiz about the water cycle for me').match).toBe(false);
  });

  it('labels a complaint as a suspected defect, not a request', () => {
    expect(on('I asked twice and nothing ever came').suspected).toBe('defect');
  });

  it('does nothing at all when no destination is configured', () => {
    const d = evaluateEscalationTrigger({
      messageBody: 'I asked twice and nothing ever came',
      escalationConfigured: false,
    });
    expect(d.match).toBe(false);
    expect(d.reason).toBe('not_configured');
  });

  it('says why it declined, so a false negative is diagnosable', () => {
    expect(on('thanks!').reason).toBe('too_short');
    expect(on('what is the capital of France exactly').reason).toBe('no_signal');
    expect(on('my students keep getting this wrong').reason).toBe('about_the_classroom');
  });
});

describe('escalation service', () => {
  const ENV = { SWITCH_ESCALATION_ROOM_ID: 'room-abc', SWITCH_ESCALATION_AGENT: 'rumi-dev-agent' };

  function load() {
    jest.resetModules();
    jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
    return require('../../bot/shared/services/escalation.service');
  }

  const fakeLlm = (answer) => ({
    chat: { completions: { create: jest.fn().mockResolvedValue({ choices: [{ message: { content: answer } }] }) } },
  });

  it('is off unless a destination room is set', () => {
    const svc = load();
    expect(svc.isConfigured({})).toBe(false);
    expect(svc.isConfigured(ENV)).toBe(true);
  });

  it.each([
    ['defect', 'defect'],
    ['request', 'request'],
    ['neither', null],
    ['Request.', 'request'],
  ])('maps the model answer %s to %s', async (answer, expected) => {
    const svc = load();
    await expect(svc.classify('something', { llm: fakeLlm(answer) })).resolves.toBe(expected);
  });

  it('briefs the agent differently for a request than a defect', async () => {
    const svc = load();
    const sent = [];
    const conn = { postMessage: jest.fn((_r, c) => { sent.push(c); return Promise.resolve({}); }) };

    await svc.send({ messageBody: 'I wish there was a /help command', kind: 'request', teacherIdentifier: 't', env: ENV, connection: conn });
    await svc.send({ messageBody: 'nothing ever came back', kind: 'defect', teacherIdentifier: 't', env: ENV, connection: conn });

    // Reproducing a fault and designing a feature are different jobs; the
    // headline and the instruction both have to say which one this is.
    expect(sent[0]).toContain('cannot do yet');
    expect(sent[0]).toMatch(/pull request/i);
    expect(sent[1]).toContain('is broken');
    expect(sent[1]).toMatch(/reproduce/i);
  });

  it('names the branch to work from, so the pull request is not opened against a stale default', async () => {
    const svc = load();
    const sent = [];
    const conn = { postMessage: jest.fn((_r, c) => { sent.push(c); return Promise.resolve({}); }) };
    const env = { ...ENV, SWITCH_ESCALATION_BASE_BRANCH: 'feat/switch-channel' };

    await svc.send({ messageBody: 'add a /help command', kind: 'request', teacherIdentifier: 't', env, connection: conn });
    await svc.send({ messageBody: 'nothing came back', kind: 'defect', teacherIdentifier: 't', env, connection: conn });

    // Both kinds need it: `gh pr create` bases a PR on the repository's default
    // branch, which on a deployment running a feature branch means a diff
    // carrying every commit that branch is ahead by.
    for (const brief of sent) expect(brief).toContain('feat/switch-channel');
  });

  it('says nothing about a branch when none is configured', async () => {
    const svc = load();
    const sent = [];
    const conn = { postMessage: jest.fn((_r, c) => { sent.push(c); return Promise.resolve({}); }) };

    await svc.send({ messageBody: 'add a /help command', kind: 'request', teacherIdentifier: 't', env: ENV, connection: conn });

    // Asserting a branch name that may not exist is worse than leaving the
    // agent to its own judgement.
    expect(sent[0]).not.toMatch(/work from|base it on/i);
    expect(sent[0]).toMatch(/pull request/i);
  });

  it('tells a teacher asking for something different from a teacher reporting a fault', () => {
    const svc = load();
    const request = svc.acknowledgement('en', 'request');
    const defect = svc.acknowledgement('en', 'defect');
    expect(request).not.toBe(defect);
    // Neither may promise it will happen — that is how the old apology failed.
    expect(request).toMatch(/can'?t promise/i);
    expect(defect).toMatch(/can'?t promise/i);
  });

  it('confirms a defect report', async () => {
    const svc = load();
    await expect(svc.confirm('nothing ever came', { llm: fakeLlm('defect') })).resolves.toBe(true);
  });

  it('rejects what the model says is not a defect', async () => {
    const svc = load();
    await expect(svc.confirm('my students struggle', { llm: fakeLlm('neither') })).resolves.toBe(false);
  });

  it('treats an LLM failure as NOT a complaint, rather than escalating everything', async () => {
    const svc = load();
    const broken = { chat: { completions: { create: jest.fn().mockRejectedValue(new Error('503')) } } };
    // A model being down must not turn every frustrated message into a ticket.
    await expect(svc.confirm('it is broken', { llm: broken })).resolves.toBe(false);
    await expect(svc.classify('it is broken', { llm: broken })).resolves.toBeNull();
  });

  it('posts the teacher\'s words VERBATIM, addressed to the agent', async () => {
    const svc = load();
    const posted = [];
    const conn = { postMessage: jest.fn((roomId, content) => { posted.push({ roomId, content }); return Promise.resolve({}); }) };

    const words = 'I asked twice and nothing ever came.\nThis is the third lesson I planned myself.';
    await svc.send({ messageBody: words, teacherIdentifier: 'switch:room|@switch-mattermost-abc-user:localhost', env: ENV, connection: conn });

    expect(posted).toHaveLength(1);
    expect(posted[0].roomId).toBe('room-abc');
    // Addressed, or the agent is merely shown it rather than woken.
    expect(posted[0].content.startsWith('@rumi-dev-agent')).toBe(true);
    // Verbatim: the exact wording is routinely the clue.
    expect(posted[0].content).toContain('I asked twice and nothing ever came.');
    expect(posted[0].content).toContain('This is the third lesson I planned myself.');
  });

  it('does not put the teacher\'s full identifier in a room other people read', async () => {
    const svc = load();
    let content = '';
    const conn = { postMessage: jest.fn((_r, c) => { content = c; return Promise.resolve({}); }) };
    const identifier = 'switch:2202d944-5596-4f01-b8b6-0915f8509a9e|@switch-mattermost-8cb57433-user:localhost';

    await svc.send({ messageBody: 'it broke again and nothing came', teacherIdentifier: identifier, env: ENV, connection: conn });

    expect(content).not.toContain(identifier);
    // A stable hash, not a slice: a Switch identifier ends in the server
    // name, so the obvious "last N characters" is ':localhost' for everyone.
    const trace = content.match(/Reporter trace: ([0-9a-f]{10})/);
    expect(trace).not.toBeNull();
    expect(content).not.toContain('localhost');
  });

  it('gives the same teacher the same trace, and different teachers different ones', async () => {
    const svc = load();
    const traces = [];
    const conn = { postMessage: jest.fn((_r, c) => { traces.push(c.match(/Reporter trace: (\S+)/)[1]); return Promise.resolve({}); }) };
    const a = 'switch:room|@switch-mattermost-aaa-user:localhost';
    const b = 'switch:room|@switch-mattermost-bbb-user:localhost';

    await svc.send({ messageBody: 'it broke and nothing came', teacherIdentifier: a, env: ENV, connection: conn });
    await svc.send({ messageBody: 'it broke and nothing came', teacherIdentifier: a, env: ENV, connection: conn });
    await svc.send({ messageBody: 'it broke and nothing came', teacherIdentifier: b, env: ENV, connection: conn });

    expect(traces[0]).toBe(traces[1]);   // same person, same trace
    expect(traces[2]).not.toBe(traces[0]); // different person, different trace
  });

  it('swallows a send failure — the teacher must never see it', async () => {
    const svc = load();
    const conn = { postMessage: jest.fn().mockRejectedValue(new Error('room gone')) };
    await expect(svc.send({ messageBody: 'x', teacherIdentifier: 'y', env: ENV, connection: conn })).resolves.toBe(false);
  });

  it('acknowledges without promising a fix date', () => {
    const svc = load();
    const ack = svc.acknowledgement('en');
    expect(ack).toMatch(/passed/i);
    // The apology this replaces failed precisely by promising future behaviour.
    expect(ack).toMatch(/can'?t promise/i);
    expect(svc.acknowledgement('ur')).not.toBe(ack);
  });
});
