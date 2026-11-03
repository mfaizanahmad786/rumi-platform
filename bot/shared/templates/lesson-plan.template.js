'use strict';
/**
 * Lesson Plan HTML Template — the local alternative to Gamma.
 *
 * Renders a five-step lesson plan to print-quality HTML for
 * shared/utils/html-to-pdf.js. Deliberately close to quiz-report.template.js
 * and reading-report.template.js so a teacher's documents look like one set:
 * Lexend body, Nastaliq for Urdu, card sections, Rumi mark in the header.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Lesson plans were the only feature that outsourced its PDF. Quiz, reading
 * and coaching reports have all rendered locally through html-to-pdf for a
 * long time; lesson plans called the Gamma API, so the headline feature of a
 * project whose premise is "bring your own keys" needed a paid third-party
 * account that most people cloning the repo will not have.
 *
 * ── Urdu is not an afterthought here ─────────────────────────────────────────
 * Most of Rumi's teachers write Urdu, so the RTL path is a first-class case,
 * not a fallback: the whole document flips direction, Nastaliq is embedded
 * (Chromium's HarfBuzz shapes it; see html-to-pdf.js), and headings and lists
 * mirror. Fonts are embedded as base64 rather than linked because the
 * renderer has no network and a missing font silently produces empty glyphs.
 */

const fs = require('fs');
const path = require('path');

// Lazy-load font + logo bytes once per process — same convention as the
// other report templates, so a process that never renders pays nothing.
let _assets = null;

function readBase64(relPath) {
  const abs = path.join(__dirname, '..', relPath);
  try {
    if (!fs.existsSync(abs)) return '';
    return fs.readFileSync(abs).toString('base64');
  } catch {
    return '';
  }
}

function assets() {
  if (_assets) return _assets;
  _assets = {
    logo: readBase64('assets/Rumi Transparent.png'),
    lexendReg: readBase64('fonts/Lexend-Regular.ttf'),
    lexendBold: readBase64('fonts/Lexend-Bold.ttf'),
    nastaliqReg: readBase64('fonts/NotoNastaliqUrdu-Regular.ttf'),
    nastaliqBold: readBase64('fonts/NotoNastaliqUrdu-Bold.ttf'),
  };
  return _assets;
}

/** Languages written right-to-left, which changes the whole page, not just the text. */
const RTL_LANGUAGES = new Set(['ur', 'ar', 'ps-PK', 'sd-PK', 'fa']);

function isRtl(language) {
  return RTL_LANGUAGES.has(String(language || 'en'));
}

/** HTML-escape. The plan comes from a model, so it is never trusted markup. */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const LABELS = {
  en: { plan: 'Lesson Plan', grade: 'Grade', subject: 'Subject', duration: 'Duration',
    objective: 'Learning objective', materials: 'Materials', steps: 'The lesson, step by step',
    assessment: 'How to check they understood', minutes: 'min', madeBy: 'Prepared by Rumi' },
  ur: { plan: 'سبق کا منصوبہ', grade: 'جماعت', subject: 'مضمون', duration: 'دورانیہ',
    objective: 'سیکھنے کا مقصد', materials: 'درکار اشیاء', steps: 'سبق، مرحلہ وار',
    assessment: 'سمجھ کی جانچ کیسے کریں', minutes: 'منٹ', madeBy: 'رومی کی تیار کردہ' },
};

function labels(language) {
  return LABELS[String(language || 'en')] || LABELS.en;
}

/**
 * @param {object} plan                 the structured plan (see lesson-plan-renderer.service.js)
 * @param {string} plan.title
 * @param {string} [plan.grade]
 * @param {string} [plan.subject]
 * @param {number} [plan.durationMinutes]
 * @param {string} plan.objective
 * @param {string[]} [plan.materials]
 * @param {Array<{title:string, minutes?:number, body:string, teacherSays?:string}>} plan.steps
 * @param {string} [plan.assessment]
 * @param {string} [language]
 * @returns {string} a complete HTML document
 */
function renderLessonPlanHtml(plan, language = 'en') {
  const a = assets();
  const rtl = isRtl(language);
  const L = labels(language);
  const dir = rtl ? 'rtl' : 'ltr';
  const bodyFont = rtl ? "'NastaliqRumi', 'LexendRumi', sans-serif" : "'LexendRumi', sans-serif";

  const meta = [
    plan.grade ? `${esc(L.grade)}: ${esc(plan.grade)}` : '',
    plan.subject ? `${esc(L.subject)}: ${esc(plan.subject)}` : '',
    plan.durationMinutes ? `${esc(L.duration)}: ${esc(plan.durationMinutes)} ${esc(L.minutes)}` : '',
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');

  const materials = (plan.materials || []).length
    ? `<section class="card">
         <h2>${esc(L.materials)}</h2>
         <ul>${plan.materials.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>
       </section>`
    : '';

  const steps = (plan.steps || []).map((s, i) => `
    <section class="card step">
      <div class="step-head">
        <span class="num">${i + 1}</span>
        <h2>${esc(s.title)}</h2>
        ${s.minutes ? `<span class="mins">${esc(s.minutes)} ${esc(L.minutes)}</span>` : ''}
      </div>
      <p>${esc(s.body)}</p>
      ${s.teacherSays ? `<blockquote>${esc(s.teacherSays)}</blockquote>` : ''}
    </section>`).join('');

  const assessment = plan.assessment
    ? `<section class="card"><h2>${esc(L.assessment)}</h2><p>${esc(plan.assessment)}</p></section>`
    : '';

  return `<!DOCTYPE html>
<html lang="${esc(language)}" dir="${dir}">
<head>
<meta charset="utf-8">
<style>
  ${a.lexendReg ? `@font-face{font-family:'LexendRumi';src:url(data:font/ttf;base64,${a.lexendReg}) format('truetype');font-weight:400;}` : ''}
  ${a.lexendBold ? `@font-face{font-family:'LexendRumi';src:url(data:font/ttf;base64,${a.lexendBold}) format('truetype');font-weight:700;}` : ''}
  ${a.nastaliqReg ? `@font-face{font-family:'NastaliqRumi';src:url(data:font/ttf;base64,${a.nastaliqReg}) format('truetype');font-weight:400;}` : ''}
  ${a.nastaliqBold ? `@font-face{font-family:'NastaliqRumi';src:url(data:font/ttf;base64,${a.nastaliqBold}) format('truetype');font-weight:700;}` : ''}

  :root { --ink:#17233a; --muted:#5b6b86; --line:#e3e8f0; --accent:#2f6f6b; --soft:#f6f8fb; }
  * { box-sizing:border-box; }
  body { margin:0; padding:0 0 28px; font-family:${bodyFont}; color:var(--ink);
         font-size:12.5pt; line-height:${rtl ? '2.1' : '1.58'}; }
  header { display:flex; align-items:center; gap:14px; padding:26px 34px 18px;
           border-bottom:3px solid var(--accent); }
  header img { height:34px; }
  header .t { flex:1; }
  h1 { margin:0; font-size:20pt; font-weight:700; line-height:1.35; }
  .meta { margin-top:5px; color:var(--muted); font-size:10.5pt; }
  main { padding:22px 34px 0; }
  .card { border:1px solid var(--line); border-radius:11px; padding:15px 18px;
          margin:0 0 13px; break-inside:avoid; }
  .card.objective { background:var(--soft); border-color:#d6e2e0; }
  h2 { margin:0 0 7px; font-size:12.5pt; font-weight:700; color:var(--accent); }
  p { margin:0; }
  ul { margin:0; padding-${rtl ? 'right' : 'left'}:1.15em; }
  li { margin:2px 0; }
  .step-head { display:flex; align-items:center; gap:10px; margin-bottom:7px; }
  .step-head h2 { margin:0; flex:1; color:var(--ink); }
  .num { flex:none; width:25px; height:25px; border-radius:50%; background:var(--accent);
         color:#fff; font-size:11pt; font-weight:700; display:flex; align-items:center;
         justify-content:center; }
  .mins { flex:none; color:var(--muted); font-size:10pt; }
  blockquote { margin:9px 0 0; padding:8px 13px; border-${rtl ? 'right' : 'left'}:3px solid var(--accent);
               background:var(--soft); color:var(--muted); font-style:${rtl ? 'normal' : 'italic'}; }
  footer { margin-top:16px; padding:0 34px; color:var(--muted); font-size:9.5pt;
           text-align:${rtl ? 'left' : 'right'}; }
  @page { size:A4; margin:13mm; }
</style>
</head>
<body>
  <header>
    ${a.logo ? `<img src="data:image/png;base64,${a.logo}" alt="">` : ''}
    <div class="t">
      <h1>${esc(plan.title || L.plan)}</h1>
      ${meta ? `<div class="meta">${meta}</div>` : ''}
    </div>
  </header>
  <main>
    <section class="card objective">
      <h2>${esc(L.objective)}</h2>
      <p>${esc(plan.objective)}</p>
    </section>
    ${materials}
    <h2 style="margin:17px 0 9px;">${esc(L.steps)}</h2>
    ${steps}
    ${assessment}
  </main>
  <footer>${esc(L.madeBy)}</footer>
</body>
</html>`;
}

module.exports = renderLessonPlanHtml;
module.exports.isRtl = isRtl;
module.exports.labels = labels;
