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
 * Any OpenAI-compatible endpoint, named directly.
 *
 * Several providers now serve the OpenAI chat-completions shape, so pointing
 * this client at one is a base URL and a key rather than a new integration.
 * Google Gemini is the reason this exists — its free tier is far more
 * generous than OpenRouter's, which matters for a project whose whole premise
 * is that a school can run it on its own keys:
 *
 *   LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
 *   LLM_API_KEY=<an AI Studio key>
 *   LLM_MODEL_OVERRIDE=gemini-2.0-flash
 *
 * The same two lines cover Groq, DeepSeek, Together, or a local Ollama or
 * LM Studio. When LLM_BASE_URL is set it wins over LLM_PROVIDER, because
 * naming an address is a more specific statement than naming a vendor.
 */
const CUSTOM_BASE_URL = (process.env.LLM_BASE_URL || '').trim().replace(/\/+$/, '');

/** True only for real OpenRouter — a custom base URL is not OpenRouter even if LLM_PROVIDER still says so. */
const IS_OPENROUTER = !CUSTOM_BASE_URL && PROVIDER !== 'openai';

/**
 * Sent as `reasoning_effort` on every chat completion when set. Unset (the
 * default), nothing is added and the request is unchanged.
 *
 * Reasoning models spend output tokens thinking before they answer, and this
 * codebase caps several calls very tightly because it was written against
 * models that do not: intent detection asks for one word with max_tokens 10,
 * and language detection and the menu router are similarly tight. On Gemini
 * 3.x the whole budget goes on reasoning and the response comes back with
 * `finish_reason: "length"` and NO content at all — which surfaced as
 * `Cannot read properties of undefined (reading 'trim')` from
 * openai.service.js, caught by a fallback that then guessed the wrong intent.
 * The visible symptom was Rumi chatting pleasantly about lesson plans instead
 * of generating one, with nothing in the log that named the cause.
 *
 *   LLM_REASONING_EFFORT=none
 *
 * is what makes those calls work on Gemini. It is opt-in rather than inferred
 * because the parameter is not universally accepted — sending it to a model
 * that does not expect it is a 400 — and because a deployment using a
 * reasoning model deliberately, for quality, should keep its reasoning.
 *
 * The durable fix is for those call sites to stop assuming a model answers
 * without thinking; this makes the models people actually have work today.
 */
const REASONING_EFFORT = (process.env.LLM_REASONING_EFFORT || '').trim();

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
  let client;

  if (CUSTOM_BASE_URL) {
    // Any OpenAI-compatible endpoint. LLM_API_KEY is the generic name; the
    // provider-specific ones are accepted too so a half-migrated .env still
    // works rather than failing with an unhelpful 401. A local server that
    // wants no auth still needs a non-empty string for the SDK.
    client = new OpenAI({
      apiKey: process.env.LLM_API_KEY
        || process.env.GEMINI_API_KEY
        || process.env.OPENAI_API_KEY
        || process.env.OPENROUTER_API_KEY
        || 'not-required',
      baseURL: CUSTOM_BASE_URL,
    });
  } else if (PROVIDER === 'openai') {
    // Direct OpenAI — no baseURL override
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  } else {
    // Default: OpenRouter — uses OpenAI-compatible API
    client = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: OPENROUTER_BASE_URL,
      defaultHeaders: {
        'HTTP-Referer': process.env.APP_URL || '',
        'X-Title': 'Rumi Teaching Assistant',
      },
    });
  }

  // One wrapper for both providers. It used to exist only on the OpenRouter
  // branch, so a direct-OpenAI deployment silently got no interception at all.
  const originalCreate = client.chat.completions.create.bind(client.chat.completions);
  client.chat.completions.create = (params, options) => {
    let model = params.model;

    // LLM_MODEL_OVERRIDE wins over whatever the call site hardcoded.
    if (MODEL_OVERRIDE) model = MODEL_OVERRIDE;

    // Auto-prefix bare names for OpenRouter ('gpt-4o-mini' → 'openai/gpt-4o-mini').
    // A fully-qualified name ('google/gemma-4-31b-it:free') already carries a
    // slash and is left alone.
    //
    // Only for real OpenRouter. The test used to be `PROVIDER !== 'openai'`,
    // which would mangle every other compatible endpoint: Gemini's model is
    // 'gemini-2.0-flash', and asking it for 'openai/gemini-2.0-flash' is a
    // 404 nobody would connect back to this line.
    if (IS_OPENROUTER && model && !model.includes('/')) {
      model = `openai/${model}`;
    }

    const changed = model !== params.model || REASONING_EFFORT;
    if (!changed) return originalCreate(params, options);

    const next = { ...params, model };
    // Never clobber a call site that has asked for a specific effort itself.
    if (REASONING_EFFORT && next.reasoning_effort === undefined) {
      next.reasoning_effort = REASONING_EFFORT;
    }
    return originalCreate(next, options);
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
  let baseURL;
  if (CUSTOM_BASE_URL) baseURL = CUSTOM_BASE_URL;
  else if (IS_OPENROUTER) baseURL = OPENROUTER_BASE_URL;
  else baseURL = 'https://api.openai.com/v1';

  return {
    provider: CUSTOM_BASE_URL ? 'compatible' : PROVIDER,
    model: DEFAULT_MODEL,
    modelOverride: MODEL_OVERRIDE || null,
    baseURL,
  };
}

module.exports = {
  createLLMClient,
  getClient,
  getDefaultModel,
  getProviderInfo,
};
