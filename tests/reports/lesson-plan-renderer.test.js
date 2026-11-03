/**
 * Producing a lesson-plan PDF without Gamma.
 *
 * Lesson plans were the only feature that outsourced their PDF to a paid
 * third party. Quiz, reading and coaching reports have always rendered
 * locally through html-to-pdf, so the headline feature of a project whose
 * premise is "bring your own keys" was the one thing you could not bring
 * your own keys for.
 *
 * The two halves are tested separately because they fail differently: the
 * model half fails on what a model emitted, the render half on what Chromium
 * did. html-to-pdf is mocked here (it has its own suite, and CI has no
 * browser); what is asserted is the data contract and the plumbing.
 */

const renderer = require('../../bot/shared/services/lesson-plan-renderer.service');

jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));

const GOOD_PLAN = {
  title: 'Understanding Equal Parts',
  grade: '3',
  subject: 'Mathematics',
  durationMinutes: 40,
  objective: 'Children can split a whole into equal parts and name halves, thirds and fourths.',
  materials: ['paper strips', 'a board'],
  steps: Array.from({ length: 5 }, (_, i) => ({
    title: `Step ${i + 1}`, minutes: 8, body: 'What the teacher does.', teacherSays: 'Say this.',
  })),
  assessment: 'Ask three children to fold a strip into quarters.',
};

const llmReturning = (content) => ({
  chat: { completions: { create: jest.fn().mockResolvedValue({ choices: [{ message: { content } }] }) } },
});

describe('plan() — getting the lesson as data, not prose', () => {
  it('parses a clean JSON response', async () => {
    const out = await renderer.plan({ topic: 'fractions', llm: llmReturning(JSON.stringify(GOOD_PLAN)) });
    expect(out.title).toBe('Understanding Equal Parts');
    expect(out.steps).toHaveLength(5);
  });

  it.each([
    ['a ```json fence', '```json\n{JSON}\n```'],
    ['a bare ``` fence', '```\n{JSON}\n```'],
    ['a sentence before it', 'Here is the plan you asked for:\n{JSON}'],
    ['a sentence after it', '{JSON}\nLet me know if you want it simpler.'],
  ])('repairs %s rather than spending another call', async (_label, wrapper) => {
    const content = wrapper.replace('{JSON}', JSON.stringify(GOOD_PLAN));
    const out = await renderer.plan({ topic: 'fractions', llm: llmReturning(content) });
    expect(out.title).toBe('Understanding Equal Parts');
  });

  it('repairs a trailing comma, which is a typo and not a refusal', () => {
    const broken = '{"a":1,"b":[1,2,],}';
    expect(JSON.parse(renderer.extractJson(broken))).toEqual({ a: 1, b: [1, 2] });
  });

  it('writes the prompt in the teacher\'s language, not about it', async () => {
    const llm = llmReturning(JSON.stringify(GOOD_PLAN));
    await renderer.plan({ topic: 'fractions', language: 'ur', llm });
    const prompt = llm.chat.completions.create.mock.calls[0][0].messages[0].content;
    // Named, not coded: a model handles "Urdu" far better than "ur".
    expect(prompt).toContain('Urdu');
    expect(prompt).not.toMatch(/in ur\b/);
  });

  it('asks for a generous token budget, because a reasoning model thinks first', async () => {
    const llm = llmReturning(JSON.stringify(GOOD_PLAN));
    await renderer.plan({ topic: 'fractions', llm });
    // The bug this avoids: a tight cap is spent on reasoning and the content
    // comes back empty (see LLM_REASONING_EFFORT in llm-client.js).
    expect(llm.chat.completions.create.mock.calls[0][0].max_tokens).toBeGreaterThanOrEqual(2000);
  });

  it.each([
    ['no title', { ...GOOD_PLAN, title: undefined }, /title/],
    ['no objective', { ...GOOD_PLAN, objective: undefined }, /objective/],
    ['no steps', { ...GOOD_PLAN, steps: [] }, /steps/],
    ['a step with no body', { ...GOOD_PLAN, steps: [{ title: 'x' }] }, /steps\[\]/],
  ])('rejects %s, and says WHAT was missing', async (_label, bad, expected) => {
    await expect(renderer.plan({ topic: 'x', llm: llmReturning(JSON.stringify(bad)) }))
      .rejects.toThrow(expected);
  });

  it('throws a named error when the response is not JSON at all', async () => {
    await expect(renderer.plan({ topic: 'x', llm: llmReturning('I cannot help with that.') }))
      .rejects.toThrow(/not JSON/);
  });

  it('throws when the model returns empty content', async () => {
    // Exactly what a reasoning model does when its budget is too small.
    await expect(renderer.plan({ topic: 'x', llm: llmReturning(null) }))
      .rejects.toThrow(/empty content/);
  });
});

describe('render() — turning the data into a file', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');

  function loadWithFakePdf() {
    jest.resetModules();
    jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
    jest.doMock('../../bot/shared/utils/html-to-pdf', () => ({
      htmlToPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
    }));
    return require('../../bot/shared/services/lesson-plan-renderer.service');
  }

  it('writes a PDF and returns its path', async () => {
    const r = loadWithFakePdf();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-'));
    const out = await r.render({ plan: GOOD_PLAN, outDir: dir });
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.readFileSync(out).toString()).toMatch(/^%PDF/);
  });

  it('names the file from the title, safely', async () => {
    const r = loadWithFakePdf();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-'));
    const out = await r.render({ plan: { ...GOOD_PLAN, title: 'Fractions: halves & thirds / part 1' }, outDir: dir });
    const name = path.basename(out);
    // A title goes into a filename, so separators and punctuation must not.
    expect(name).not.toMatch(/[/:&]/);
    expect(name.endsWith('.pdf')).toBe(true);
  });

  it('keeps non-Latin titles rather than emptying the filename', async () => {
    const r = loadWithFakePdf();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-'));
    const out = await r.render({ plan: { ...GOOD_PLAN, title: 'کسر کا سبق' }, outDir: dir, });
    // \p{L} rather than a-z: stripping to ASCII would leave every Urdu plan
    // called the same fallback name.
    expect(path.basename(out)).not.toBe('lesson-plan.pdf');
  });
});

describe('the HTML template', () => {
  const render = require('../../bot/shared/templates/lesson-plan.template');

  it('puts every step in the document', () => {
    const html = render(GOOD_PLAN, 'en');
    for (const s of GOOD_PLAN.steps) expect(html).toContain(s.title);
    expect(html).toContain(GOOD_PLAN.objective);
    expect(html).toContain(GOOD_PLAN.assessment);
  });

  it('flips the whole document for Urdu, not just the text', () => {
    const html = render({ ...GOOD_PLAN, title: 'کسر' }, 'ur');
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('NastaliqRumi');   // shaped by Chromium's HarfBuzz
    expect(html).toContain('سبق کا منصوبہ'.slice(0, 3)); // labels are translated too
  });

  it('escapes model output, which is never trusted markup', () => {
    const html = render({ ...GOOD_PLAN, objective: '<script>alert(1)</script>' }, 'en');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders without optional fields rather than printing "undefined"', () => {
    const minimal = { title: 'T', objective: 'O', steps: [{ title: 'S', body: 'B' }] };
    const html = render(minimal, 'en');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('null');
  });

  it('knows which languages are right-to-left', () => {
    expect(render.isRtl('ur')).toBe(true);
    expect(render.isRtl('ar')).toBe(true);
    expect(render.isRtl('en')).toBe(false);
    expect(render.isRtl(undefined)).toBe(false);
  });
});
