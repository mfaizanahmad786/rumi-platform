'use strict';
/**
 * lesson-plan-renderer — producing a lesson-plan PDF without Gamma.
 *
 * Lesson plans were the only feature that outsourced their PDF. Quiz, reading
 * and coaching reports have all rendered locally through
 * shared/utils/html-to-pdf.js for a long time; this brings the headline
 * feature onto the same path, so a clone of this repo with no Gamma account
 * still produces the thing teachers actually came for.
 *
 * Two steps, and they fail differently, so they are separable and separately
 * testable:
 *
 *   1. plan()   — ask the LLM for the lesson as DATA, not prose
 *   2. render() — turn that data into a PDF with the local engine
 *
 * ── Why JSON and not prose ───────────────────────────────────────────────────
 * Asking a model for "a nicely formatted lesson plan" gets markdown whose
 * shape changes between calls, and every renderer then grows a parser for
 * whatever it felt like emitting. Asking for a fixed object means the
 * template can rely on fields existing, and a malformed response is caught
 * once, here, where there is still something sensible to do about it.
 *
 * ── On repair rather than retry ──────────────────────────────────────────────
 * Models wrap JSON in code fences, add a sentence before it, or trail a
 * comma. Those are presentation accidents, not refusals, so they are repaired
 * locally instead of spending another call. A response that is genuinely not
 * a plan throws, and the worker's existing failure path handles it.
 */

const path = require('path');
const fs = require('fs');
const { logToFile } = require('../utils/logger');

/** How many steps a plan has. Five is what the product has always promised teachers. */
const STEP_COUNT = 5;

const LANGUAGE_NAMES = {
  en: 'English', ur: 'Urdu', ar: 'Arabic', es: 'Spanish', fr: 'French',
  hi: 'Hindi', bn: 'Bengali', mr: 'Marathi', te: 'Telugu', ta: 'Tamil', kn: 'Kannada',
  'pa-PK': 'Punjabi', 'sd-PK': 'Sindhi', 'ps-PK': 'Pashto',
};

function languageName(code) {
  return LANGUAGE_NAMES[String(code || 'en')] || 'English';
}

/**
 * Strips what models put around JSON. Not a parser — a de-wrapper, applied
 * before JSON.parse so the common accidents never reach it.
 */
function extractJson(raw) {
  let text = String(raw || '').trim();

  // ```json ... ``` or ``` ... ```
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();

  // A sentence before or after the object ("Here is the plan: { ... }").
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) text = text.slice(first, last + 1);

  // A trailing comma before a closing brace or bracket.
  text = text.replace(/,\s*([}\]])/g, '$1');

  return text;
}

/**
 * Checks the model returned a plan rather than something plan-shaped.
 * Throws with what was actually missing, because "invalid plan" in a log at
 * 2am tells whoever reads it nothing.
 */
function validate(plan) {
  const problems = [];
  if (!plan || typeof plan !== 'object') throw new Error('Lesson plan: model returned no object');
  if (!plan.title) problems.push('title');
  if (!plan.objective) problems.push('objective');
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) problems.push('steps');
  else if (plan.steps.some((s) => !s || !s.title || !s.body)) problems.push('steps[].title/body');
  if (problems.length) {
    throw new Error(`Lesson plan: model response missing ${problems.join(', ')}`);
  }
  return plan;
}

/**
 * Ask the LLM for the lesson as structured data.
 *
 * @param {object} args
 * @param {string} args.topic             what to teach
 * @param {string} [args.fullUserMessage] the teacher's own words, for context
 * @param {string} [args.language]        language code the plan is written IN
 * @param {object} [args.llm]             injectable client, for tests
 * @returns {Promise<object>} a validated plan
 */
async function plan({ topic, fullUserMessage = '', language = 'en', llm } = {}) {
  // eslint-disable-next-line global-require -- lazy: keeps this module free of the LLM stack until used
  const client = llm || require('./llm-client').getClient();
  const lang = languageName(language);

  const prompt = `You are preparing a lesson plan for a primary-school teacher.

Topic: ${topic}
${fullUserMessage ? `The teacher said: "${fullUserMessage}"` : ''}

Write the plan in ${lang}. Every piece of text you produce must be in ${lang}.

Return ONLY a JSON object, no commentary, in exactly this shape:

{
  "title": "short title for the lesson",
  "grade": "the grade level, if the teacher mentioned one, else null",
  "subject": "the subject, if clear, else null",
  "durationMinutes": 40,
  "objective": "one sentence: what a child can do by the end that they could not before",
  "materials": ["things the teacher needs, cheap and commonly available"],
  "steps": [
    {
      "title": "what this step is called",
      "minutes": 5,
      "body": "what the TEACHER does, concretely. Not theory.",
      "teacherSays": "one sentence the teacher can say out loud, in ${lang}"
    }
  ],
  "assessment": "how the teacher checks, in the lesson, that it landed"
}

Rules:
- Exactly ${STEP_COUNT} steps.
- Assume a crowded classroom with few resources: no printer, no projector, no internet.
- "body" tells the teacher what to DO. A teacher should be able to follow it without re-reading.
- Minutes across all steps should add up to durationMinutes.`;

  const completion = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.6,
    // Generous: a five-step plan is long, and a reasoning model spends part
    // of this budget thinking before it writes anything.
    max_tokens: 4000,
  });

  const raw = completion?.choices?.[0]?.message?.content;
  if (!raw) throw new Error('Lesson plan: model returned empty content');

  let parsed;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (error) {
    logToFile('Lesson plan: could not parse model response', {
      error: error.message, sample: String(raw).slice(0, 300),
    });
    throw new Error('Lesson plan: model response was not JSON');
  }

  return validate(parsed);
}

/**
 * Render a plan to a PDF on disk.
 *
 * Returns the path rather than a buffer because that is what the worker
 * sends — WhatsAppService.sendDocument takes a path, and Gamma's own path
 * downloaded to a file first too, so this slots into the same shape.
 */
async function render({ plan: planData, language = 'en', outDir, filename } = {}) {
  // eslint-disable-next-line global-require -- lazy, matching this directory's convention
  const renderLessonPlanHtml = require('../templates/lesson-plan.template');
  // eslint-disable-next-line global-require
  const { htmlToPdf } = require('../utils/html-to-pdf');

  const html = renderLessonPlanHtml(planData, language);
  const pdf = await htmlToPdf(html);

  const dir = outDir || require('os').tmpdir();
  fs.mkdirSync(dir, { recursive: true });

  const safe = String(planData.title || 'lesson-plan')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim().replace(/\s+/g, '_')
    .slice(0, 50) || 'lesson-plan';
  const target = path.join(dir, filename || `${safe}.pdf`);

  fs.writeFileSync(target, pdf);
  logToFile('✅ Lesson plan rendered locally', { target, bytes: pdf.length, language });
  return target;
}

/** plan() then render(), which is what callers almost always want. */
async function generate({ topic, fullUserMessage, language = 'en', outDir, filename, llm } = {}) {
  const planData = await plan({ topic, fullUserMessage, language, llm });
  const pdfPath = await render({ plan: planData, language, outDir, filename });
  return { plan: planData, pdfPath };
}

module.exports = {
  STEP_COUNT,
  languageName,
  extractJson,
  validate,
  plan,
  render,
  generate,
};
