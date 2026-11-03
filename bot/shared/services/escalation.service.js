'use strict';
/**
 * escalation — Rumi reporting its own failures to the people who can fix them.
 *
 * A teacher says a lesson plan never arrived. Today Rumi apologises, promises
 * (untruthfully) to do better, and the report dies in the chat: nobody who
 * could fix it ever hears about it. This service carries it instead — into a
 * linked Switch room where engineers and a coding agent work, addressed so
 * the agent is woken rather than merely shown it.
 *
 * ── Why this is Switch-only ──────────────────────────────────────────────────
 * It needs somewhere to escalate TO. A WhatsApp or Slack conversation is one
 * teacher and one bot; a Switch room is a place where people and agents work
 * together, and rooms can be linked. That is the capability being used here,
 * not merely a second way to send a message, so this lives behind the Switch
 * channel's configuration rather than in the shared handler path.
 *
 * ── Two stages, and why ──────────────────────────────────────────────────────
 * escalation-trigger.js runs a cheap regex gate on every message. Only what
 * it promotes reaches `confirm()` below, which asks a model the question a
 * regex cannot answer: is this a complaint about RUMI, or just a hard day?
 * Ordinary teaching chat therefore costs nothing, and the judgement call
 * still gets a model.
 *
 * ── Failing quietly is the point ─────────────────────────────────────────────
 * Every path here is best-effort. A teacher asking for help must never see an
 * error because an escalation could not be delivered — the escalation is for
 * Rumi's benefit, not theirs. Failures are logged and swallowed.
 */

const { logToFile } = require('../utils/logger');

/** Where escalations go, and who they wake. Presence-gated, like every other feature here. */
function config(env = process.env) {
  return {
    roomId: (env.SWITCH_ESCALATION_ROOM_ID || '').trim(),
    agentName: (env.SWITCH_ESCALATION_AGENT || 'rumi-dev-agent').trim(),
    baseBranch: (env.SWITCH_ESCALATION_BASE_BRANCH || '').trim(),
  };
}

function isConfigured(env = process.env) {
  return Boolean(config(env).roomId);
}

/**
 * What IS this, in terms engineering can act on?
 *
 * Three answers, because two of them are worth passing on and they are not
 * the same thing. "Nothing came back" is a fault in something that exists;
 * "I wish it could do X" is a gap where nothing exists yet. Both died in the
 * chat before this, and both deserve to reach the people who build Rumi —
 * but whoever picks one up needs to know which they are holding, because
 * reproducing a defect and designing a feature are different jobs.
 *
 * The third answer is the important one to get right. "My students found
 * fractions hard" is the problem Rumi EXISTS to help with, and escalating it
 * to engineers would be both useless and faintly insulting. The prompt draws
 * that line with examples rather than adjectives.
 *
 * Returns null on any error: an LLM that is down must not turn every
 * frustrated message into an engineering ticket.
 *
 * @returns {Promise<'defect'|'request'|null>}
 */
async function classify(messageBody, { llm } = {}) {
  // eslint-disable-next-line global-require -- lazy: keeps this module free of the LLM stack until used
  const client = llm || require('./llm-client').getClient();

  const prompt = `A teacher wrote this to Rumi, an AI teaching assistant.

Answer with ONE word: defect, request, or neither.

defect — they are reporting that something in Rumi IS BROKEN:
- "I asked for a lesson plan twice and nothing came"
- "you replied in English when I write in Urdu"
- "the voice note thing gave an error"

request — they are asking for something Rumi CANNOT DO YET:
- "I wish there was a /help command"
- "could you add Sindhi to the languages?"
- "it would help if I could download the plan as Word"

neither — anything else:
- "my students keep getting fractions wrong"   (a teaching problem, which is what Rumi is for)
- "I am exhausted, this week has been awful"   (venting)
- "can you make the plan simpler?"             (a normal use of a feature that works)
- "the textbook has a mistake on page 40"      (wrong about the world, not about Rumi)

Teacher's message:
${messageBody}`;

  try {
    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 5,
      temperature: 0,
    });
    const answer = (completion?.choices?.[0]?.message?.content || '').trim().toLowerCase();
    if (answer.startsWith('defect')) return 'defect';
    if (answer.startsWith('request')) return 'request';
    return null;
  } catch (error) {
    logToFile('Escalation: could not classify, treating as nothing to escalate', { error: error.message });
    return null;
  }
}

/** Kept for callers that only care whether this is a defect. */
async function confirm(messageBody, opts) {
  return (await classify(messageBody, opts)) === 'defect';
}

/**
 * Post the report into the engineering room.
 *
 * The teacher's words go in VERBATIM and quoted. A summary would be Rumi's
 * interpretation of a failure Rumi was part of, and the exact wording is
 * routinely the clue — "it stopped" and "it said it was preparing one" point
 * at different code. The `@agent` prefix is what makes this an addressed
 * event rather than something the agent merely sees.
 */
async function send({ messageBody, teacherIdentifier, kind = 'defect', env = process.env, connection } = {}) {
  const { roomId, agentName, baseBranch } = config(env);
  if (!roomId) return false;

  // eslint-disable-next-line global-require -- lazy, matching this directory's convention
  const conn = connection || require('./messaging/switch-connection');

  // A stable, non-identifying handle for the reporter.
  //
  // Whoever picks this up needs to tell two reports apart and match one
  // against the logs, but a Switch identifier names a real person and this
  // room has other people in it. A hash gives both: the same teacher always
  // produces the same trace, and the trace reveals nothing.
  //
  // It is a hash rather than a slice of the id because the obvious slice is
  // worthless here — a Switch identifier ends in the server name, so the
  // last twelve characters are ":localhost" for every teacher alive.
  const trace = teacherIdentifier
    // eslint-disable-next-line global-require -- lazy, matching this file's convention
    ? require('crypto').createHash('sha256').update(String(teacherIdentifier)).digest('hex').slice(0, 10)
    : 'unknown';

  // The brief differs because the job does: a defect is reproduced, a request
  // is designed. Saying which saves the agent guessing from the wording.
  const headline = kind === 'request'
    ? `@${agentName} a teacher is asking for something Rumi cannot do yet.`
    : `@${agentName} a teacher is reporting that Rumi is broken.`;
  const instruction = kind === 'request'
    ? ['Please find where this would fit, keep the change small, and add a test',
       'that fails without it. Open a pull request rather than pushing to the branch.']
    : ['Please reproduce it from what they wrote before changing anything, and',
       'write a test that fails on the bug first.'];

  // Which branch the pull request is against.
  //
  // `gh pr create` defaults its base to the repository's default branch, which
  // is only the right answer when the deployment runs from it. Rumi is just as
  // often running a release or feature branch that is dozens of commits ahead —
  // and a PR opened against a stale default carries every one of those commits,
  // so the one change under review is buried in a diff nobody can read.
  //
  // Named rather than detected: the agent and the bot need not share a checkout
  // (a worktree, a container, another machine entirely), so the branch this
  // process happens to have checked out is not evidence about the agent's. Left
  // unset, this says nothing and the agent falls back to its own judgement —
  // better than asserting a branch name that may not exist.
  if (baseBranch) {
    instruction.push(`Work from \`${baseBranch}\` — that is the branch this Rumi is running, and what any pull request should target.`);
  }

  const body = [
    headline,
    '',
    'Their words, verbatim:',
    `> ${String(messageBody).replace(/\n/g, '\n> ')}`,
    '',
    `Reporter trace: ${trace}`,
    '',
    ...instruction,
  ].join('\n');

  try {
    await conn.postMessage(roomId, body);
    logToFile('✅ Escalated a teacher report to the engineering room', { roomId, agentName, trace });
    return true;
  } catch (error) {
    logToFile('❌ Escalation failed to send', { error: error.message, roomId });
    return false;
  }
}

/**
 * What Rumi tells the teacher. Deliberately plain, and deliberately NOT a
 * promise about when it will be fixed — the apology this replaces failed by
 * promising exactly that.
 */
function acknowledgement(language = 'en', kind = 'defect') {
  if (kind === 'request') {
    const asks = {
      en: "That's a fair ask, and not something I can do today. "
        + "I've passed it to the people who build me, in your words. "
        + "I can't promise it will be built, but it is in front of someone who could.",
      ur: 'یہ مناسب مطالبہ ہے، لیکن فی الحال میں یہ نہیں کر سکتا۔ '
        + 'میں نے آپ کی بات ان لوگوں تک پہنچا دی ہے جو مجھے بناتے ہیں۔ '
        + 'وعدہ نہیں کر سکتا کہ یہ بنے گا، لیکن اب یہ ان کے سامنے ہے۔',
    };
    return asks[language] || asks.en;
  }
  const messages = {
    en: "Thank you for telling me — that's a fault on my side, not yours. "
      + "I've passed your exact words to the people who maintain me. "
      + "I can't promise when it'll be fixed, but it is now in front of someone who can look at it.",
    ur: 'بتانے کا شکریہ — یہ میری خرابی ہے، آپ کی نہیں۔ '
      + 'میں نے آپ کے الفاظ ان لوگوں تک پہنچا دیے ہیں جو مجھے بناتے ہیں۔ '
      + 'میں وعدہ نہیں کر سکتا کہ یہ کب ٹھیک ہوگا، لیکن اب یہ ان کے سامنے ہے۔',
  };
  return messages[language] || messages.en;
}

module.exports = {
  config,
  isConfigured,
  classify,
  confirm,
  send,
  acknowledgement,
};
