'use strict';
/**
 * Pure, dependency-free decision helper + renderer for the /help command.
 * Kept separate from text-message.handler so it is unit-testable without the
 * handler's full dependency graph (the same shape as homework-trigger.js).
 *
 * Why this exists: a teacher asked for it, in these words —
 *
 *   "It would really help if i could type /help and see what you can do"
 *
 * Until now the only way to see the feature list was /menu (a WhatsApp
 * carousel) or to ask a question phrased well enough for the capability
 * detector to catch it. Neither is discoverable by someone who has just been
 * handed a phone number and told it can help them teach.
 *
 * The list is rendered from capabilities.config.js rather than written out
 * here. That file already carries the "⚠️ update this file when you add a
 * feature" banner and already backs the capability detector, so rendering it
 * means /help cannot drift out of date on its own — there is one list, not a
 * second copy that silently goes stale. (It is a plain object literal with no
 * side effects, so requiring it keeps this module cheap to unit-test.)
 */

const { capabilities } = require('../config/capabilities.config');
const { botName } = require('../config/branding');

/**
 * The whole message must be "/help" — nothing else on the line.
 *
 * Anchored deliberately, because the sentence that prompted this feature is
 * itself a near-miss: "it would really help If i typed /help and see what you
 * can do" contains /help but is a FEATURE REQUEST, and must keep reaching
 * escalation-trigger.js rather than being answered with the help text. A
 * loose /\/help/ would swallow it and silently kill the escalation path this
 * repo already built for exactly that sentence.
 */
const HELP_TRIGGER_RX = /^\s*\/help\s*$/i;

/** Header and footer, in the four languages capabilities.config.js carries. */
const HEADER = {
  en: `Here's what I can help you with:`,
  ur: `میں آپ کی ان چیزوں میں مدد کر سکتا ہوں:`,
  ar: `إليك ما يمكنني مساعدتك به:`,
  es: `Esto es en lo que puedo ayudarte:`,
};

const FOOTER = {
  en: `Just tell me what you need, in your own language — or type /menu to browse.`,
  ur: `بس اپنی زبان میں بتائیں کہ آپ کو کیا چاہیے — یا /menu ٹائپ کریں۔`,
  ar: `أخبرني فقط بما تحتاجه بلغتك — أو اكتب /menu للتصفح.`,
  es: `Solo dime qué necesitas, en tu idioma — o escribe /menu para explorar.`,
};

/** Picks `language` off a {en, ur, ar, es} field, falling back to English. */
function localise(field, language) {
  if (!field) return '';
  return field[language] || field.en || '';
}

/**
 * Side-effect-free: does this message ask for the help listing?
 * @returns {{match: boolean}}
 */
function evaluateHelpTrigger({ messageBody } = {}) {
  return { match: HELP_TRIGGER_RX.test(messageBody || '') };
}

/**
 * Renders the capability listing as plain text.
 *
 * Plain text with `*bold*` rather than an interactive list, because this has
 * to read correctly on every channel driver — WhatsApp, Baileys, Slack,
 * Discord and Switch all receive the same string. /menu already owns the
 * rich-carousel version and degrades to its own text fallback.
 *
 * @param {string} language - a supported language code; unknown codes fall back to English.
 * @returns {string}
 */
function buildHelpMessage(language = 'en') {
  const entries = capabilities.map((cap) => {
    const name = localise(cap.name, language);
    const description = localise(cap.description, language);
    const howToUse = localise(cap.howToUse, language);
    return `*${name}*\n${description}\n↳ ${howToUse}`;
  });

  return [
    `${botName} — ${localise(HEADER, language)}`,
    entries.join('\n\n'),
    localise(FOOTER, language),
  ].join('\n\n');
}

module.exports = { HELP_TRIGGER_RX, evaluateHelpTrigger, buildHelpMessage };
