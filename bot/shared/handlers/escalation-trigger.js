'use strict';
/**
 * Pure, dependency-free decision helper for escalating a teacher's complaint
 * about Rumi ITSELF to the engineers.
 *
 * Kept separate from text-message.handler so it is unit-testable without the
 * handler's full dependency graph — same shape as homework-trigger.js.
 *
 * ── What this is for ─────────────────────────────────────────────────────────
 * Rumi is a product, not its own engineer. When a teacher reports that Rumi
 * is BROKEN — a lesson plan that never arrived, a reply in the wrong
 * language, a feature that errors — the LLM currently apologises and moves
 * on. Observed live, it went further and promised a fix it cannot make:
 *
 *   "Moving forward, I will always deliver your full lesson plan right away
 *    in the very same message so you never have to wait"
 *
 * Rumi cannot change its own delivery path. That apology is a lie told
 * kindly, and the teacher is let down again next time. The report also dies
 * in the chat: nobody who could fix it ever hears about it.
 *
 * So a complaint is routed to people (and agents) who CAN act on it, and the
 * teacher is told plainly that it has been passed on — which is true, and
 * unlike the apology, checkable.
 *
 * ── Why two stages ───────────────────────────────────────────────────────────
 * This file is stage one: a cheap, synchronous keyword gate that is
 * deliberately GENEROUS. Stage two (escalation.service.js) asks an LLM
 * whether the message is really a complaint about Rumi, and only that
 * confirmation escalates. The split exists so the common case — ordinary
 * teaching chat — costs nothing, while the judgement call still gets a model
 * rather than a regex.
 *
 * Being generous here is the right trade in one direction only: a false
 * positive costs one cheap LLM call and nothing else, while a false negative
 * silently drops a real bug report. The phrases below are therefore signals
 * of FRUSTRATION, not of any particular feature, and the stage-two prompt is
 * what has to be precise.
 */

/**
 * Signals that a message might be a complaint about Rumi. Each is a phrase a
 * frustrated teacher plausibly writes about something not working; none is
 * specific enough to escalate on alone.
 */
const COMPLAINT_SIGNALS = [
  // nothing happened
  /\bnothing (ever )?(came|happened|arrived|showed)\b/i,
  /\bnever (came|arrived|got|received|sent|showed)\b/i,
  /\bdidn'?t (work|come|arrive|send|get|receive|respond|reply)\b/i,
  /\bdid not (work|come|arrive|send|respond|reply)\b/i,
  /\bno (response|reply|answer)\b/i,
  // it stopped / is stuck
  /\b(stopped|stuck|hangs?|hanging|frozen|freezes)\b/i,
  /\bstill waiting\b/i,
  // it is broken
  /\b(broken|not working|doesn'?t work|does not work)\b/i,
  /\b(error|failed|failing|crash(ed|es)?)\b/i,
  // it is wrong
  /\b(wrong|incorrect) (language|answer|grade|subject|plan)\b/i,
  // repetition, which is what turns an annoyance into a report
  /\b(again|twice|three times|third time|every time|each time|keeps?)\b/i,
  // Urdu — the languages most of Rumi's teachers actually write in
  /کام نہیں کر/,
  /کچھ نہیں آیا/,
  /دوبارہ/,
];

/**
 * Signals that a message might be asking for something Rumi cannot do.
 *
 * A request is not a defect, and the difference is worth keeping: "nothing
 * came back" is a fault, "I wish it could do X" is a gap. Both deserve to
 * reach the people who build Rumi and both previously died in the chat, but
 * an engineer picking one up needs to know which they are holding.
 */
const REQUEST_SIGNALS = [
  /\b(i wish|wish (you|it)|would be (great|good|nice|helpful)|it would help if)\b/i,
  // "add/support/include" only. NOT "make" or "build": "can you make me a
  // lesson plan" is the single most common thing a teacher says to Rumi, and
  // promoting it would mean a classifier call on nearly every request.
  /\b(can|could|would) you (please )?(add|support|include)\b/i,
  /\b(is there|do you have) (a |any )?way to\b/i,
  /\b(please )?add (a|an|the)?\s*\w+\s*(command|option|button|feature)\b/i,
  /\bfeature request\b/i,
  // Urdu
  /شامل کر/,
  /کاش/,
];

/**
 * Phrases that look like complaints but are about the CLASSROOM, not Rumi.
 * A teacher saying "my students keep getting this wrong" is describing the
 * exact problem Rumi exists to help with — escalating that to engineers
 * would be both useless and insulting.
 */
const CLASSROOM_NOT_RUMI = [
  /\b(my |the )?(students?|children|kids|class|pupils|learners)\b/i,
  /\bhomework (is|was)\b/i,
];

/**
 * Does this message deserve the stage-two LLM check?
 *
 * Fires on a complaint OR a request — the model tells them apart afterwards.
 *
 * Side-effect-free and synchronous, so it can run on every inbound message
 * without cost. Returns a reason so the log says WHY a message was promoted,
 * which is what makes a false positive diagnosable rather than mysterious.
 *
 * @param {object} args
 * @param {string} args.messageBody        the teacher's text
 * @param {boolean} args.escalationConfigured  whether a destination exists
 * @returns {{match: false, reason?: string} | {match: true, signal: string}}
 */
function evaluateEscalationTrigger({ messageBody, escalationConfigured }) {
  // No destination means no escalation. Checked first so an unconfigured
  // deployment does no work at all, not even the regexes.
  if (!escalationConfigured) return { match: false, reason: 'not_configured' };

  const text = String(messageBody || '').trim();
  if (text.length < 15) return { match: false, reason: 'too_short' };

  const complaint = COMPLAINT_SIGNALS.find((rx) => rx.test(text));
  const request = REQUEST_SIGNALS.find((rx) => rx.test(text));
  const signal = complaint || request;
  if (!signal) return { match: false, reason: 'no_signal' };

  // A complaint that names students is about teaching, not about Rumi —
  // unless it ALSO names Rumi, which makes it "your plan confused my
  // students", a real report.
  const aboutClassroom = CLASSROOM_NOT_RUMI.some((rx) => rx.test(text));
  const namesRumi = /\brumi\b/i.test(text) || /\byou(r)?\b/i.test(text);
  if (aboutClassroom && !namesRumi) return { match: false, reason: 'about_the_classroom' };

  // What the gate SUSPECTS, not what it concludes — the model decides, and
  // regularly disagrees. Carried so the log says why a message was promoted.
  return { match: true, signal: String(signal), suspected: complaint ? 'defect' : 'request' };
}

module.exports = {
  COMPLAINT_SIGNALS,
  REQUEST_SIGNALS,
  CLASSROOM_NOT_RUMI,
  evaluateEscalationTrigger,
};
