/**
 * menu-text — rendering a menu as numbered text, for channels with no native
 * interactive components.
 *
 * WhatsApp (Meta) and Slack can render real buttons and select menus. Baileys
 * cannot, and neither can Switch: a Switch room may be mirrored into Slack,
 * Teams, Discord, Telegram or Mattermost, so the honest common denominator is
 * text. Both degrade the same way — print the options numbered, remember the
 * mapping, and let pending-options.js resolve "2" or "English" back to an
 * option id.
 *
 * ── Why this module exists ───────────────────────────────────────────────────
 * baileys-channel.service.js has its own private copy of everything here. It
 * is NOT yet calling this module: changing a working driver and adding a new
 * one in the same breath is two risks where one will do. This module is the
 * intended single home, and folding Baileys into it is a mechanical follow-up
 * — the two must not be allowed to drift.
 *
 * The one thing deliberately NOT duplicated is the language list. Baileys'
 * own header records why: an early version hardcoded ten languages copied from
 * whatsapp.service.js, which silently dropped Hindi, Bengali, Marathi, Telugu,
 * Tamil and Kannada for anyone in the India region. resolveLanguageOptions
 * below reads config/supported-languages.js and the region's own config, the
 * same source of truth Meta's driver uses, so a language added there appears
 * on every text channel without anyone remembering to update a list.
 */

const { logToFile } = require('../../utils/logger');

// Offered when a region declares no list of its own. A fallback, not the
// catalogue — the real set comes from supported-languages.js per region.
const DEFAULT_PICKER_CODES = ['en', 'ur', 'pa-PK', 'sd-PK', 'ps-PK', 'bal-PK', 'ta-LK', 'ar', 'es'];

const STYLE_OPTIONS = [
  { id: 'style_photorealistic', title: 'Photorealistic', description: 'Camera-quality, HDR, 8K realistic images' },
  { id: 'style_infographic', title: 'Infographic', description: 'TED-Ed/Kurzgesagt flat vector style' },
  { id: 'style_cartoon', title: 'Cartoon', description: 'Pixar-inspired animated characters' },
  { id: 'style_sketch', title: 'Sketch', description: 'Whiteboard hand-drawn style' },
];

const FEATURE_MENU_OPTIONS = [
  { id: 'menu_lesson_plan', title: 'Lesson Plans', description: 'Create detailed PDF lesson plans' },
  { id: 'menu_coaching', title: 'Classroom Coaching', description: 'Get teaching feedback from recordings' },
  { id: 'menu_reading', title: 'Reading Assessment', description: 'Test student reading fluency' },
  { id: 'menu_video', title: 'AI Video Generation', description: 'Create educational videos' },
  { id: 'menu_other', title: 'Ask Anything', description: 'General teaching questions' },
];

function isRedundantDescription(title, description) {
  if (!description) return true;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  return norm(title) === norm(description);
}

/**
 * An example drawn from THIS menu rather than a fixed one. A hardcoded
 * '"2" or "English"' was actively confusing on a list of school grades.
 */
function exampleName(options) {
  const first = (options || []).find((o) => o && o.title);
  return first ? first.title : 'yes';
}

function renderOptionsAsText({ header, body, footer, options }) {
  const lines = [];
  if (header) lines.push(`*${header}*`);
  if (body) lines.push(body);
  lines.push('');
  (options || []).forEach((opt, i) => {
    const gloss = isRedundantDescription(opt.title, opt.description) ? '' : ` — ${opt.description}`;
    lines.push(`${i + 1}. ${opt.title}${gloss}`);
  });
  if (footer) { lines.push(''); lines.push(`_${footer}_`); }
  lines.push('');
  // Both forms are accepted (see pending-options.js#resolveSelection) —
  // demanding a number is unrealistic when people type the name instead.
  lines.push(`Reply with a number or the name — e.g. "1" or "${exampleName(options)}".`);
  return lines.join('\n');
}

/**
 * Which language codes to offer, from the shared config and the region's own
 * config, failing open to DEFAULT_PICKER_CODES. See the header for why this
 * is read rather than hardcoded.
 */
async function resolveLanguageOptions(region = null) {
  // eslint-disable-next-line global-require -- lazy, matching this directory's convention
  const { LANGUAGES, SUPPORTED_LANGUAGES } = require('../../config/supported-languages');

  let codes = DEFAULT_PICKER_CODES;
  try {
    // eslint-disable-next-line global-require -- lazy: avoids a DB-backed service on module load
    const RegionFeaturesService = require('../region-features.service');
    const feats = await RegionFeaturesService.getRegionFeatures(region);
    const fromRegion = Array.isArray(feats.supported_languages)
      ? feats.supported_languages.filter((c) => SUPPORTED_LANGUAGES.includes(c))
      : [];
    // Only trust the region list when it is more specific than the trivial
    // ['en'] fail-open default.
    if (fromRegion.length > 1) codes = fromRegion;
  } catch (error) {
    logToFile('Language picker: region lookup failed, using default set', { error: error.message });
  }

  return [
    { id: 'lang_auto', title: 'Auto-detect', description: 'Let me detect your language automatically' },
    ...codes.map((code) => ({
      id: `lang_${code}`,
      title: LANGUAGES[code]?.native || code,
      description: `${LANGUAGES[code]?.english || code} language`,
    })),
  ];
}

const LANGUAGE_MENU_CHROME = {
  header: 'Select Language / زبان منتخب کریں',
  body: 'Choose your preferred language. I will respond in this language for all conversations.',
  footer: 'You can change this anytime by typing /language',
};

module.exports = {
  DEFAULT_PICKER_CODES,
  STYLE_OPTIONS,
  FEATURE_MENU_OPTIONS,
  LANGUAGE_MENU_CHROME,
  isRedundantDescription,
  exampleName,
  renderOptionsAsText,
  resolveLanguageOptions,
};
