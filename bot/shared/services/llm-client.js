/**
 * LLM Client Factory
 *
 * Provides a unified interface to LLM providers using the OpenAI SDK.
 * Default: OpenRouter (one key for 500+ models).
 * Override: Direct OpenAI (set LLM_PROVIDER=openai + OPENAI_API_KEY).
 *
 * When using OpenRouter, model names are auto-prefixed with 'openai/' if no
 * provider prefix is present (e.g. 'gpt-4o-mini' → 'openai/gpt-4o-mini').
 * This means existing code can use bare OpenAI model names unchanged.
 *
 * Usage:
 *   const { getClient, getDefaultModel } = require('./llm-client');
 *   const client = getClient();
 *   const response = await client.chat.completions.create({
 *     model: 'gpt-4o-mini',  // auto-prefixed to 'openai/gpt-4o-mini' on OpenRouter
 *     messages: [{ role: 'user', content: 'Hello' }],
 *   });
 */

const OpenAI = require('openai');

const PROVIDER = (process.env.LLM_PROVIDER || 'openrouter').toLowerCase();
const DEFAULT_MODEL = process.env.LLM_MODEL || 'openai/gpt-4o';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * When LLM_MODEL_OVERRIDE is set, every chat completion through this client
 * uses it, whatever model the call site asked for. Unset (the default), every
 * call site keeps the model it names and nothing changes.
 *
 * This exists because Rumi is a bring-your-own-keys project and its 54 chat
 * call sites all pass a literal — 'gpt-4o-mini' 37 times, 'gpt-4o' 17 — so
 * there was no way to run it against a provider that does not serve those
 * models, or on an OpenRouter account with no credit. Intercepting at the one
 * place all 29 consumer files already pass through is a far smaller change
 * than threading a default through every one of them.
 *
 * It is deliberately NOT called LLM_MODEL, even though that reads better.
 * LLM_MODEL is shipped non-empty in .env.template ('openai/gpt-4o'), so
 * teaching it to override would have silently promoted all 37 deliberate
 * gpt-4o-mini calls to full gpt-4o for every deployment that copied the
 * template — a large, unrequested cost increase appearing in someone's bill
 * with no change on their side. A new name is opt-in by construction.
 *
 * (LLM_MODEL itself remains what it always was: the value getDefaultModel()
 * returns. Nothing calls that today, which is why the knob .env.template
 * documents has never actually done anything.)
 *
 * Scope: EVERY chat completion made through this client, which includes the
 * vision calls — vision.service.js and the pic-to-LP services send their
 * images through this same chat.completions.create. So when this is set it
 * also supersedes VISION_MODEL / PIC_LP_CLASSIFIER_MODEL /
 * PIC_LP_EXTRACTOR_MODEL, and the model named here must be one that can see,
 * or image handling will fail. Pick a vision-capable model.
 *
 * Image GENERATION is unaffected — Kie.ai and DALL·E are separate services
 * with their own clients, not chat completions.
 */
const MODEL_OVERRIDE = (process.env.LLM_MODEL_OVERRIDE || '').trim();

let _client = null;

/**
 * Create a new LLM client configured for the current provider.
 * For OpenRouter, wraps chat.completions.create to auto-prefix model names.
 */
function createLLMClient() {
  const client = PROVIDER === 'openai'
    // Direct OpenAI — no baseURL override
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    // Default: OpenRouter — uses OpenAI-compatible API
    : new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: OPENROUTER_BASE_URL,
      defaultHeaders: {
        'HTTP-Referer': process.env.APP_URL || '',
        'X-Title': 'Rumi Teaching Assistant',
      },
    });

  // One wrapper for both providers. It used to exist only on the OpenRouter
  // branch, so a direct-OpenAI deployment silently got no interception at all.
  const originalCreate = client.chat.completions.create.bind(client.chat.completions);
  client.chat.completions.create = (params, options) => {
    let model = params.model;

    // LLM_MODEL_OVERRIDE wins over whatever the call site hardcoded.
    if (MODEL_OVERRIDE) model = MODEL_OVERRIDE;

    // Auto-prefix bare names for OpenRouter ('gpt-4o-mini' → 'openai/gpt-4o-mini').
    // A fully-qualified name ('meta-llama/llama-3.3-70b-instruct:free') already
    // carries a slash and is left alone.
    if (PROVIDER !== 'openai' && model && !model.includes('/')) {
      model = `openai/${model}`;
    }

    return originalCreate(model === params.model ? params : { ...params, model }, options);
  };

  return client;
}

/**
 * Get a singleton LLM client instance.
 */
function getClient() {
  if (!_client) {
    _client = createLLMClient();
  }
  return _client;
}

/**
 * Get the default model name.
 */
function getDefaultModel() {
  return DEFAULT_MODEL;
}

/**
 * Get current provider info (for diagnostics/health checks).
 */
function getProviderInfo() {
  return {
    provider: PROVIDER,
    model: DEFAULT_MODEL,
    modelOverride: MODEL_OVERRIDE || null,
    baseURL: PROVIDER === 'openrouter' ? OPENROUTER_BASE_URL : 'https://api.openai.com/v1',
  };
}

module.exports = {
  createLLMClient,
  getClient,
  getDefaultModel,
  getProviderInfo,
};
