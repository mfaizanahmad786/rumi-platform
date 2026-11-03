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

  it('confirms a defect report', async () => {
    const svc = load();
    await expect(svc.confirm('nothing ever came', { llm: fakeLlm('yes') })).resolves.toBe(true);
  });

  it('rejects what the model says is not a defect', async () => {
    const svc = load();
    await expect(svc.confirm('my students struggle', { llm: fakeLlm('no') })).resolves.toBe(false);
  });

  it('treats an LLM failure as NOT a complaint, rather than escalating everything', async () => {
    const svc = load();
    const broken = { chat: { completions: { create: jest.fn().mockRejectedValue(new Error('503')) } } };
    // A model being down must not turn every frustrated message into a ticket.
    await expect(svc.confirm('it is broken', { llm: broken })).resolves.toBe(false);
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
