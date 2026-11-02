/**
 * LLM_MODEL_OVERRIDE must select the model every call actually uses.
 *
 * All 54 chat call sites pass a literal — 'gpt-4o-mini' 37 times, 'gpt-4o'
 * 17 — so there was no way to point Rumi at a different model at all. That
 * matters to anyone running it on an OpenRouter account with no credit, or on
 * a provider that simply does not serve gpt-4o, which is a normal way to run
 * a bring-your-own-keys project.
 *
 * The knob is NOT called LLM_MODEL, although .env.template has documented
 * that name as "Override the default model" all along (and it never did
 * anything — getDefaultModel() is its only reader and nothing calls that).
 * Teaching LLM_MODEL to override would have hit every deployment that copied
 * the template, where it ships non-empty as 'openai/gpt-4o': all 37
 * deliberate gpt-4o-mini calls would have silently become full gpt-4o, which
 * is a large cost increase arriving with no change on the operator's side.
 * The last test below pins that an unset override changes nothing.
 *
 * These tests assert the interception, the model name left alone when nothing
 * is set, and the OpenRouter prefixing rule that has to keep working
 * alongside it.
 */

const CAPTURED = [];

function loadClient(env) {
  jest.resetModules();
  CAPTURED.length = 0;

  jest.doMock('openai', () => {
    return function FakeOpenAI(opts) {
      this._opts = opts;
      this.chat = {
        completions: {
          create: (params) => {
            CAPTURED.push(params);
            return Promise.resolve({ choices: [{ message: { content: 'ok' } }] });
          },
        },
      };
    };
  }, { virtual: true });

  const saved = { ...process.env };
  Object.assign(process.env, env);
  // eslint-disable-next-line global-require
  const mod = require('../../bot/shared/services/llm-client');
  return { mod, restore: () => { process.env = saved; } };
}

describe('LLM_MODEL_OVERRIDE selects the model every call actually uses', () => {
  const originalEnv = { ...process.env };
  afterEach(() => { process.env = { ...originalEnv }; jest.resetModules(); });

  it('overrides a hardcoded model name', async () => {
    const { mod, restore } = loadClient({
      LLM_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'k',
      LLM_MODEL_OVERRIDE: 'meta-llama/llama-3.3-70b-instruct:free',
    });

    // 'gpt-4o-mini' is what 37 call sites pass literally.
    await mod.getClient().chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(CAPTURED[0].model).toBe('meta-llama/llama-3.3-70b-instruct:free');
    restore();
  });

  it('leaves a fully-qualified override alone rather than prefixing it', async () => {
    const { mod, restore } = loadClient({
      LLM_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'k',
      LLM_MODEL_OVERRIDE: 'google/gemini-2.0-flash-exp:free',
    });

    await mod.getClient().chat.completions.create({ model: 'gpt-4o', messages: [] });

    // Would be 'openai/google/gemini-...' if the prefix rule ran on it.
    expect(CAPTURED[0].model).toBe('google/gemini-2.0-flash-exp:free');
    restore();
  });

  it('still auto-prefixes a bare call-site model on OpenRouter when no override is set', async () => {
    const { mod, restore } = loadClient({
      LLM_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'k',
      LLM_MODEL_OVERRIDE: '',
    });

    await mod.getClient().chat.completions.create({ model: 'gpt-4o-mini', messages: [] });

    expect(CAPTURED[0].model).toBe('openai/gpt-4o-mini');
    restore();
  });

  it('does not prefix on direct OpenAI, and still honours the override there', async () => {
    const { mod, restore } = loadClient({
      LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'k',
      LLM_MODEL_OVERRIDE: 'gpt-4o-mini',
    });

    await mod.getClient().chat.completions.create({ model: 'gpt-4o', messages: [] });

    // The wrapper used to exist only on the OpenRouter branch, so a direct
    // OpenAI deployment got no interception at all.
    expect(CAPTURED[0].model).toBe('gpt-4o-mini');
    restore();
  });

  it('reports the override so `doctor` and health checks can show it', () => {
    const { mod, restore } = loadClient({
      LLM_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'k',
      LLM_MODEL_OVERRIDE: 'meta-llama/llama-3.3-70b-instruct:free',
    });

    expect(mod.getProviderInfo().modelOverride).toBe('meta-llama/llama-3.3-70b-instruct:free');
    restore();
  });

  it('changes nothing about the request when no override is set', async () => {
    const { mod, restore } = loadClient({
      LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'k',
      LLM_MODEL_OVERRIDE: '',
    });

    const params = { model: 'gpt-4o', messages: [], temperature: 0.4 };
    await mod.getClient().chat.completions.create(params);

    expect(CAPTURED[0]).toEqual(params);
    restore();
  });
});

/**
 * Any OpenAI-compatible endpoint, named by LLM_BASE_URL.
 *
 * Gemini is why this exists: its free tier is far more generous than
 * OpenRouter's, which matters for a project whose premise is that a school
 * runs it on its own keys. The same two settings cover Groq, DeepSeek, a
 * local Ollama or LM Studio.
 *
 * Before this, those paths were unreachable twice over — llm-client had no
 * way to take a base URL, and feature-availability demanded an OpenRouter key
 * at boot whatever provider was configured.
 */
describe('LLM_BASE_URL points Rumi at any OpenAI-compatible endpoint', () => {
  const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/openai';
  const originalEnv = { ...process.env };
  afterEach(() => { process.env = { ...originalEnv }; jest.resetModules(); });

  it('uses the given base URL and key', () => {
    const { mod, restore } = loadClient({
      LLM_BASE_URL: GEMINI,
      LLM_API_KEY: 'gemini-key',
    });

    const client = mod.getClient();
    expect(client._opts.baseURL).toBe(GEMINI);
    expect(client._opts.apiKey).toBe('gemini-key');
    restore();
  });

  it('does NOT prefix the model with openai/ on a custom endpoint', async () => {
    const { mod, restore } = loadClient({
      LLM_BASE_URL: GEMINI,
      LLM_API_KEY: 'k',
      LLM_MODEL_OVERRIDE: 'gemini-2.0-flash',
    });

    await mod.getClient().chat.completions.create({ model: 'gpt-4o-mini', messages: [] });

    // The prefix rule used to key off `PROVIDER !== 'openai'`, which would
    // have asked Gemini for 'openai/gemini-2.0-flash' — a 404 nobody would
    // connect back to that line.
    expect(CAPTURED[0].model).toBe('gemini-2.0-flash');
    restore();
  });

  it('a bare call-site model is left bare too, not mangled', async () => {
    const { mod, restore } = loadClient({ LLM_BASE_URL: GEMINI, LLM_API_KEY: 'k' });

    await mod.getClient().chat.completions.create({ model: 'gemini-2.0-flash', messages: [] });

    expect(CAPTURED[0].model).toBe('gemini-2.0-flash');
    restore();
  });

  it('a base URL wins over LLM_PROVIDER, which is the less specific statement', () => {
    const { mod, restore } = loadClient({
      LLM_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'ork',
      LLM_BASE_URL: GEMINI,
      LLM_API_KEY: 'k',
    });

    expect(mod.getClient()._opts.baseURL).toBe(GEMINI);
    expect(mod.getProviderInfo().provider).toBe('compatible');
    restore();
  });

  it('a trailing slash on the base URL is tolerated', () => {
    const { mod, restore } = loadClient({ LLM_BASE_URL: `${GEMINI}/`, LLM_API_KEY: 'k' });
    expect(mod.getClient()._opts.baseURL).toBe(GEMINI);
    restore();
  });
});

describe('the boot check asks for the key the deployment will actually use', () => {
  const fa = require('../../bot/shared/config/feature-availability');

  it('demands an OpenRouter key by default', () => {
    expect(fa.requiredVarsFor({})).toContain('OPENROUTER_API_KEY');
  });

  it('demands an OpenAI key when LLM_PROVIDER=openai', () => {
    const vars = fa.requiredVarsFor({ LLM_PROVIDER: 'openai' });
    expect(vars).toContain('OPENAI_API_KEY');
    expect(vars).not.toContain('OPENROUTER_API_KEY');
  });

  it('demands LLM_API_KEY when a custom endpoint is named', () => {
    const vars = fa.requiredVarsFor({ LLM_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai' });
    expect(vars).toContain('LLM_API_KEY');
    // The bug this fixes: a Gemini deployment was refused at boot for want of
    // an OpenRouter key it would never have used.
    expect(vars).not.toContain('OPENROUTER_API_KEY');
  });

  it('keeps the required list the same length whichever provider is configured', () => {
    const base = fa.requiredVarsFor({}).length;
    expect(fa.requiredVarsFor({ LLM_PROVIDER: 'openai' })).toHaveLength(base);
    expect(fa.requiredVarsFor({ LLM_BASE_URL: 'http://localhost:11434/v1' })).toHaveLength(base);
  });
});

/**
 * LLM_REASONING_EFFORT — making tightly-capped calls work on reasoning models.
 *
 * Several call sites cap output hard because they want one word: intent
 * detection sends max_tokens 10. A reasoning model spends that budget
 * thinking and returns finish_reason 'length' with no content, which reached
 * openai.service.js as `Cannot read properties of undefined (reading 'trim')`
 * — caught by a fallback that then guessed the wrong intent, so Rumi chatted
 * about lesson plans instead of generating one.
 *
 * Verified against the live Gemini endpoint before being written:
 *   max_tokens:10                        -> content=None, finish=length
 *   max_tokens:10 + reasoning_effort:none -> content='lesson_plan', finish=stop
 */
describe('LLM_REASONING_EFFORT', () => {
  const originalEnv = { ...process.env };
  afterEach(() => { process.env = { ...originalEnv }; jest.resetModules(); });

  it('is added to every call when set', async () => {
    const { mod, restore } = loadClient({
      LLM_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai',
      LLM_API_KEY: 'k',
      LLM_REASONING_EFFORT: 'none',
    });

    await mod.getClient().chat.completions.create({ model: 'gemini-3.6-flash', messages: [], max_tokens: 10 });

    expect(CAPTURED[0].reasoning_effort).toBe('none');
    expect(CAPTURED[0].max_tokens).toBe(10); // the cap itself is untouched
    restore();
  });

  it('is absent when unset, leaving the request byte-for-byte alone', async () => {
    const { mod, restore } = loadClient({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'k' });

    const params = { model: 'gpt-4o-mini', messages: [], max_tokens: 10 };
    await mod.getClient().chat.completions.create(params);

    expect(CAPTURED[0]).toEqual(params);
    expect('reasoning_effort' in CAPTURED[0]).toBe(false);
    restore();
  });

  it('never overrides a call site that set its own effort', async () => {
    const { mod, restore } = loadClient({
      LLM_BASE_URL: 'https://x.test/v1', LLM_API_KEY: 'k', LLM_REASONING_EFFORT: 'none',
    });

    await mod.getClient().chat.completions.create({ model: 'm', messages: [], reasoning_effort: 'high' });

    expect(CAPTURED[0].reasoning_effort).toBe('high');
    restore();
  });
});
