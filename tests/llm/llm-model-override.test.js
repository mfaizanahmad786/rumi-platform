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
