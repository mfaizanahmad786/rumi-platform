#!/usr/bin/env node
/**
 * interactive-setup.js — `rumi setup`, the guided path from a fresh clone to a
 * WhatsApp conversation with Rumi.
 *
 * Written for the person who has never seen this codebase: someone at a school
 * or an NGO who was told "you can run this yourself". Four things follow from
 * that, and they explain most of the shape of this file:
 *
 *   1. **Nothing is asked by its variable name.** The question is "where does
 *      Rumi keep its memory", not "SUPABASE_URL". Storage keys are an
 *      implementation detail of `.env`, not vocabulary the user must learn.
 *   2. **Every answer is checked while the person who typed it is still here.**
 *      A key that is merely *present* tells you nothing; the failure it causes
 *      surfaces hours later inside a feature, with no clue which of eight
 *      values was wrong. Each step probes the real service before moving on.
 *   3. **Progress is saved after each step, not at the end.** Ctrl+C is a
 *      legitimate way to leave — the browser tab for the next credential is
 *      often the reason — so quitting must never cost work already done.
 *   4. **Anything already working is not asked about again.** Re-running the
 *      wizard on a configured deployment should take seconds and change
 *      nothing. Pass `--reconfigure` to be asked everything regardless.
 *
 * Usage:
 *   rumi setup [--reconfigure]
 *   node bot/scripts/setup/interactive-setup.js
 *
 * @module interactive-setup
 */

// A `rumi` command is a conversation with a person, so its output must stay
// human-readable. bot/shared/utils/structured-logger.js replaces console.* with
// JSON logging for the server, and any module that reaches it (the WhatsApp
// connection does) would take this command's output with it — a QR code and a
// wizard, rendered as log records. Set before the first require, since the
// override happens at import time.
process.env.RUMI_CLI = '1';

const path = require('path');
const { spawnSync } = require('child_process');

const ui = require('./ui');
const { createIo, PromptAbortError, waitForAnyKey } = require('./prompt');
const { readEnvFile, writeEnvVars } = require('./env-file');
const validators = require('./validators');
const dbSetup = require('./db-setup');
const fields = require('./fields');
const summary = require('./summary');

const ROOT = path.resolve(__dirname, '../../..');
const ENV_PATH = path.join(ROOT, '.env');
const ENV_TEMPLATE_PATH = path.join(ROOT, '.env.template');
const TOTAL_STEPS = 7;
const LOCAL_REDIS = { url: 'redis://localhost:6379', container: 'rumi-redis', image: 'redis:7-alpine' };

// ── Shared plumbing ──────────────────────────────────────────────────────────

/**
 * Builds the `save` function every step uses: patches `.env` in place and
 * updates the live env, so the next step's live check sees what the last step
 * collected without a restart.
 *
 * @param {object} env  mutated in place — this is the wizard's working env
 * @returns {(vars: Record<string,string>) => void}
 */
function createSaver(env, envPath = ENV_PATH) {
  return (vars) => {
    const meaningful = Object.fromEntries(
      Object.entries(vars).filter(([, value]) => value !== undefined && value !== ''),
    );
    if (!Object.keys(meaningful).length) return;
    Object.assign(env, meaningful);
    writeEnvVars(envPath, meaningful, { fromTemplatePath: ENV_TEMPLATE_PATH });
  };
}

/**
 * Runs one of doctor.js's live probes. Probes throw on network failure; a
 * wizard step wants a verdict, never an exception, so failures come back as
 * `{ok: false}` with the message the user should see.
 *
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
async function probe(name, env) {
  const { defaultProbes } = require('./doctor');
  try {
    return await defaultProbes[name](env);
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

/**
 * The values `.env.template` ships, so the wizard can tell a real answer from a
 * value it put there itself. Read once, lazily.
 */
let templateDefaultsCache;
function templateDefaults(templatePath = ENV_TEMPLATE_PATH) {
  if (!templateDefaultsCache) {
    try { templateDefaultsCache = readEnvFile(templatePath); } catch { templateDefaultsCache = {}; }
  }
  return templateDefaultsCache;
}

/**
 * Did a *person* give us this value?
 *
 * Not the same question as "is it non-empty". `.env` is created from the
 * template, and the template ships working-looking values —
 * `REDIS_URL=redis://localhost:6379`, `SUPABASE_URL=https://your-project.supabase.co`
 * — which are suggestions, not configuration. Counting them as answers produced
 * three wrong things on a genuinely fresh install, all seen in a live run:
 * "Picking up from last time — 2 of 3 core services are already configured" on a
 * clone that had configured nothing; "Checking the Redis you already have… ✘"
 * about a Redis nobody had claimed to have; and prompts offering
 * `[https://your-project.supabase.co]` as the value to keep, where pressing
 * Enter accepts a placeholder.
 *
 * @returns {boolean}
 */
function isProvided(env, key) {
  const value = env[key];
  if (!value) return false;
  if (/^CHANGEME/i.test(value)) return false;
  if (/^(your-|https:\/\/your-)/i.test(value)) return false;
  return value !== templateDefaults()[key];
}

/** True when a person has given us every one of `keys`. */
function hasAll(env, keys) {
  return keys.every((key) => isProvided(env, key));
}

/** The value to offer as "press Enter to keep this", or '' when there is none. */
function prefill(env, key) {
  return isProvided(env, key) ? env[key] : '';
}

/**
 * A value that is still the template's own suggestion — worth trying quietly,
 * but not worth announcing as something the user already had.
 */
function isTemplateSuggestion(env, key) {
  return Boolean(env[key]) && !isProvided(env, key) && !/^CHANGEME/i.test(env[key]);
}

/**
 * Opens a step at the top of a cleared screen, with a tick for everything
 * already done above it.
 *
 * The clearing is why: a prompt printed after five screens of scroll sits on the
 * terminal's bottom line, far from the explanation it belongs to. The ticks are
 * why it is safe to clear — orientation survives, in one line per step instead
 * of a screenful.
 */
const completedSteps = [];
function beginStep(index, title) {
  ui.clearScreen();
  console.log('');
  console.log(ui.progressBar(index, TOTAL_STEPS));
  // What is already done reads as history above the current step, not as a note
  // underneath its heading.
  for (const done of completedSteps) console.log(`  ${ui.ok(ui.dim(done))}`);
  console.log('');
  console.log(ui.bold(title));
}

/** Records a step as done, so later screens can show it as a tick. */
function finishStep(title) {
  if (!completedSteps.includes(title)) completedSteps.push(title);
}

/**
 * A live check with a spinner, retried by the caller on failure. Returns the
 * probe verdict so a step can decide whether "no" is fatal.
 */
async function checkLive(label, name, env, successText) {
  const spin = ui.spinner(label);
  const result = await probe(name, env);
  if (result.ok) spin.succeed(successText(result.detail));
  else spin.fail(ui.paint('danger', result.detail));
  return result;
}

// ── Step 1: the database ─────────────────────────────────────────────────────

const SUPABASE_WALKTHROUGH = [
  'Open https://supabase.com/dashboard/new and sign in (the free plan is plenty)',
  'Give the project any name, choose the region closest to your teachers, and let it start up — about two minutes',
  'Open Project settings → Data API → Copy the API URL (without /rest/v1) and service_role key',
];

/**
 * Collects and verifies the Supabase connection, then makes sure Rumi's tables
 * exist. Writes through the caller's saver as it goes rather than returning
 * anything — every step is durable the moment its answer is accepted.
 */
async function stepDatabase(io, env, save, opts = {}) {
  beginStep(1, 'Where Rumi keeps its memory');
  console.log(ui.say('Every teacher, lesson plan and reading score Rumi produces is stored in a database that belongs to you — not to us. Supabase gives you one free.'));

  const configured = hasAll(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  if (configured && !opts.reconfigure) {
    const check = await checkLive('Checking the database you already have…', 'supabase', env, () => 'Database already connected');
    if (check.ok) return ensureTables(io, env);
    console.log(ui.say('Let us set that up again.'));
  }

  console.log('');
  console.log(ui.steps(SUPABASE_WALKTHROUGH));

  for (;;) {
    const url = await io.ask('API URL', {
      fallback: prefill(env, 'SUPABASE_URL'),
      validate: validators.supabaseUrl,
      hint: 'On that page, the field called "API URL" — copy it without the /rest/v1 at the end.',
    });
    const key = await io.ask('Service key', {
      secret: true,
      fallback: prefill(env, 'SUPABASE_SERVICE_ROLE_KEY'),
      validate: validators.supabaseServiceKey,
      hint: 'Go to Settings → API Keys → Legacy anon, service_role API keys. Copy the "service_role" key (click Reveal first). It is hidden as you type.',
    });

    save({ SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key });
    const check = await checkLive('Talking to your database…', 'supabase', env, (d) => `Connected to Supabase ${ui.dim(d)}`);
    if (check.ok) break;
    console.log(ui.aside('That did not connect. Check the project has finished starting up, then try again.'));
  }

  return ensureTables(io, env);
}

/**
 * Creates Rumi's tables if they aren't there.
 *
 * The `exec_sql` detour is unavoidable and is the single most common place a
 * self-serve setup dies: Supabase offers no API for running arbitrary SQL, so
 * the schema is applied through a small function that itself has to be pasted
 * in by hand, once. Naming that plainly — and linking straight to the right
 * project's SQL editor — is the difference between a two-minute step and an
 * abandoned install.
 */
async function ensureTables(io, env) {
  const spin = ui.spinner('Looking for Rumi\'s tables…');
  const status = await dbSetup.inspectDatabase(env);
  spin.stop();

  if (status.state === 'ready') {
    console.log(ui.ok(`Tables already set up ${ui.dim(`(${status.detail})`)}`));
    return;
  }
  if (status.state === 'unreachable') {
    console.log(ui.warn(`Could not check the tables: ${status.detail}`));
    return;
  }

  if (status.state === 'needs-helper') {
    console.log('');
    console.log(ui.say('Rumi needs to create about seventy tables. Supabase does not allow a script to run SQL directly, so there is one thing to paste by hand first — this is the only manual step in the whole setup.'));
    console.log('');
    const editor = dbSetup.sqlEditorUrl(env.SUPABASE_URL);
    console.log(ui.steps([
      editor ? `Open ${editor}` : 'Open the SQL Editor in your Supabase project',
      'Paste everything in the box below and press Run — include the grant and the notify line',
      'Come back here',
    ]));
    console.log('');
    console.log(ui.box(dbSetup.EXEC_SQL_DEFINITION, { title: 'copy this', role: 'accent' }));
    console.log('');
    await io.pressEnter('Press Enter once you have run it');

    const waiting = ui.spinner('Waiting for Supabase to see the helper…');
    const recheck = await dbSetup.waitForExecSql(env);
    waiting.stop();
    if (!recheck.present) {
      throw new Error(
        'The SQL helper is still not visible, so the tables were not created. '
        + 'In the SQL editor, paste the whole box (including GRANT and NOTIFY), press Run, '
        + 'then run `rumi setup` again. Setup will not continue without the tables — '
        + 'that is what makes "Hi" crash with a missing `users` table.'
      );
    }
  }

  const applying = ui.spinner('Creating tables, security rules and starter data… (about a minute)');
  const result = await dbSetup.applySchema(env);
  if (result.ok) applying.succeed(`Database ready ${ui.dim(`(${result.applied.length} files applied)`)}`);
  else {
    applying.fail('Could not finish setting up the tables');
    for (const failure of result.errors) console.log(ui.aside(`${failure.file}: ${failure.error}`));
    throw new Error(
      'The database still has no Rumi tables, so setup stopped here. '
      + 'Fix the error above, then run `npm run bootstrap:db` or `rumi setup` again. '
      + 'Do not start the bot until that succeeds — messages will fail with a missing `users` table.'
    );
  }
}

// ── Step 2: the AI ───────────────────────────────────────────────────────────

/**
 * The providers this wizard can set up. Each is just a base URL and a key —
 * llm-client.js talks the OpenAI chat-completions shape to all of them, so
 * adding one here is a row, not an integration.
 */
const LLM_PROVIDERS = [
  {
    id: 'openrouter',
    label: 'OpenRouter — one account, 500+ models',
    baseUrl: '',            // the built-in default; no LLM_BASE_URL needed
    keyVar: 'OPENROUTER_API_KEY',
    keyUrl: 'https://openrouter.ai/keys',
    model: '',              // call sites pick per-call models
    note: 'Needs a few dollars of credit. A key with none answers a greeting and then fails on anything substantial.',
  },
  {
    id: 'gemini',
    label: 'Google Gemini — generous free tier',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyVar: 'LLM_API_KEY',
    keyUrl: 'https://aistudio.google.com/apikey',
    model: 'gemini-3.6-flash',
    reasoning: 'none',      // 3.x models think first and blow small token caps
    note: 'Free, but the daily request limit is low — fine for trying Rumi, not for a classroom.',
  },
  {
    id: 'compatible',
    label: 'Something else that speaks the OpenAI API',
    baseUrl: null,          // asked for
    keyVar: 'LLM_API_KEY',
    keyUrl: null,
    model: null,            // asked for
    note: 'Groq, DeepSeek, Together, or a local Ollama / LM Studio.',
  },
];

async function stepBrain(io, env, save, opts = {}) {
  beginStep(2, 'How Rumi thinks');
  console.log(ui.say('Rumi needs an AI model to write lesson plans, score reading and hold a conversation. Any provider that speaks the OpenAI API will do — pick whichever you already have.'));

  const alreadySet = isProvided(env, 'LLM_BASE_URL') || hasAll(env, ['OPENROUTER_API_KEY']);
  if (alreadySet && !opts.reconfigure) {
    const check = await checkLive('Checking the AI you already have…', 'llm', env, (d) => `AI already connected ${ui.dim(d)}`);
    if (check.ok) return;
    console.log(ui.say('Let us set that up again.'));
  }

  console.log('');
  const choice = await io.select('Which one?', LLM_PROVIDERS.map((p) => ({
    label: p.label,
    hint: p.note,
    value: p.id,
  })), 'openrouter');
  const provider = LLM_PROVIDERS.find((p) => p.id === choice) || LLM_PROVIDERS[0];

  let baseUrl = provider.baseUrl;
  if (baseUrl === null) {
    baseUrl = await io.ask('API base URL', {
      hint: 'The address its chat-completions endpoint lives under — e.g. https://api.groq.com/openai/v1 or http://localhost:11434/v1.',
      validate: (input) => {
        const value = String(input || '').trim().replace(/\/+$/, '');
        if (!value) return { ok: false, reason: 'This can\'t be empty.' };
        if (!/^https?:\/\//.test(value)) return { ok: false, reason: 'Needs to start with http:// or https://.' };
        if (/\/chat\/completions$/.test(value)) {
          return { ok: false, reason: 'Leave off /chat/completions — Rumi adds that itself.' };
        }
        return { ok: true, value };
      },
    });
  }

  if (provider.keyUrl) {
    console.log('');
    console.log(ui.steps([`Open ${provider.keyUrl} and create a key`]));
    if (provider.note) console.log(ui.aside(provider.note));
  }

  for (;;) {
    const key = await io.ask('API key', {
      secret: true,
      fallback: prefill(env, provider.keyVar),
      validate: provider.id === 'openrouter' ? validators.openrouterKey : undefined,
    });

    let model = provider.model;
    if (model === null) {
      model = await io.ask('Model name', {
        hint: 'Exactly as that provider names it — Rumi sends this verbatim.',
        fallback: prefill(env, 'LLM_MODEL_OVERRIDE'),
      });
    }

    // Written together so a half-applied provider never ends up in .env: a
    // base URL without its key is a deployment that fails at the first
    // message rather than at startup.
    save({
      [provider.keyVar]: key,
      LLM_BASE_URL: baseUrl || '',
      LLM_MODEL_OVERRIDE: model || '',
      LLM_REASONING_EFFORT: provider.reasoning || '',
    });

    const spin = ui.spinner('Asking it to say hello…');
    const check = await probe(baseUrl ? 'llm' : 'openrouter', env);
    if (check.ok) {
      spin.succeed(`AI connected ${ui.dim(check.detail)}`);
      return;
    }

    // A rejected key is a different problem from a valid key with no money on
    // it, and only the first is worth re-asking about.
    if (/credit/i.test(check.detail)) {
      spin.warn(check.detail);
      const carryOn = await io.confirm('That key works but cannot pay for a request yet. Carry on and add credit later?', true);
      if (carryOn) return;
    } else if (/no content/i.test(check.detail)) {
      // Worth naming, because it looks like a dead key and is not one.
      spin.warn(check.detail);
      save({ LLM_REASONING_EFFORT: 'none' });
      const retry = await probe('llm', env);
      if (retry.ok) {
        console.log(ui.ok(`Fixed — that model reasons before answering, so Rumi now tells it not to. ${ui.dim(retry.detail)}`));
        return;
      }
      console.log(ui.aside(retry.detail));
    } else {
      spin.fail(ui.paint('danger', `That did not work (${check.detail})`));
    }
  }
}

// ── Step 3: Redis ────────────────────────────────────────────────────────────

/** Is there a Docker daemon we could actually start a container on? */
function dockerAvailable() {
  const result = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 });
  return result.status === 0;
}

/**
 * Starts (or restarts) a local Redis container. Reusing a container that
 * already exists matters more than it sounds: someone re-running setup would
 * otherwise hit "the container name is already in use" and be stuck at a
 * Docker error in the middle of a WhatsApp tutorial.
 *
 * @returns {{ok: boolean, detail: string}}
 */
function startLocalRedis(run = spawnSync) {
  const created = run('docker', ['run', '-d', '--name', LOCAL_REDIS.container, '-p', '6379:6379', LOCAL_REDIS.image], { encoding: 'utf-8' });
  if (created.status === 0) return { ok: true, detail: 'started a new container' };

  const message = `${created.stderr || ''}`;
  if (/already in use/i.test(message)) {
    const started = run('docker', ['start', LOCAL_REDIS.container], { encoding: 'utf-8' });
    if (started.status === 0) return { ok: true, detail: 'reused the container from last time' };
    return { ok: false, detail: (started.stderr || '').trim() || 'could not start the existing container' };
  }
  return { ok: false, detail: message.trim().split('\n').pop() || 'docker could not start Redis' };
}

async function stepMemory(io, env, save, opts = {}) {
  beginStep(3, 'Rumi\'s short-term memory');
  console.log(ui.say('While a teacher is mid-conversation — halfway through a reading assessment, say — Rumi holds the thread in Redis. It also runs the slow work in the background, like marking a quiz.'));

  if (!opts.reconfigure && hasAll(env, ['REDIS_URL'])) {
    const check = await checkLive('Checking the Redis you already have…', 'redis', env, () => 'Short-term memory already connected');
    if (check.ok) return;
    console.log(ui.say('That one is not answering. Let us set it up again.'));
  } else if (!opts.reconfigure && isTemplateSuggestion(env, 'REDIS_URL')) {
    // The template's own suggestion (a local Redis). Worth trying, but silently:
    // announcing a check for something the user never configured, and then
    // failing it in red, reads as though setup is already broken.
    const check = await probe('redis', env);
    if (check.ok) {
      console.log(ui.ok(`Short-term memory ready ${ui.dim(`(a Redis is already running at ${env.REDIS_URL})`)}`));
      return;
    }
  }

  // Injectable so both branches are testable on any machine. A spy on the
  // export cannot reach this — the call is to the local binding — and a test
  // that depends on whether the *test runner's* host has a Docker daemon is a
  // test that passes for the wrong reason.
  const hasDocker = (opts.dockerAvailable || dockerAvailable)();

  const options = [];
  if (hasDocker) {
    options.push({ value: 'docker', label: 'Start one here with Docker', hint: 'One command, nothing to sign up for. Best for trying Rumi out.' });
  }
  options.push({ value: 'paste', label: 'I have an address to paste', hint: 'A Railway or Upstash instance, or a Redis you already run.' });

  // Without Docker there is nothing to offer, so the question would be a
  // one-item menu. Say where to *get* one instead — seen in a live fresh-clone
  // run on a machine with no Docker daemon: the step asked for an address and
  // explained the format, but never said how someone with no Redis at all was
  // supposed to obtain one, which makes it a dead end rather than a step.
  if (options.length === 1) {
    console.log('');
    console.log(ui.say('If you do not have one yet, either of these takes about two minutes:'));
    console.log(ui.steps([
      'Free hosted: sign up at https://upstash.com, create a Redis database, and copy its TCP URL (redis://) — not the REST URL',
      'On your own machine: install Docker, then `docker run -d -p 6379:6379 redis:7-alpine` and use redis://localhost:6379',
      'Already running one on a server? Paste its address — it only has to be reachable from here.',
    ]));
  }

  let how = options.length > 1 ? await io.select('Where should Redis come from?', options, 'docker') : 'paste';

  for (;;) {
    if (how === 'docker') {
      // One attempt only. Falling through to the paste prompt without clearing
      // this would re-run `docker run` on every retry, so a bad pasted address
      // would restart a container that had already failed.
      how = 'paste';
      const spin = ui.spinner('Starting Redis…');
      const started = startLocalRedis();
      if (started.ok) spin.succeed(`Redis running on your machine ${ui.dim(`(${started.detail})`)}`);
      else spin.fail(`Docker could not start it: ${started.detail}`);
      if (started.ok) {
        save({ REDIS_URL: LOCAL_REDIS.url });
        const check = await checkLive('Saying hello to Redis…', 'redis', env, () => 'Short-term memory ready');
        if (check.ok) return;
      }
      console.log(ui.aside('Paste an address instead.'));
    }

    const url = await io.ask('Redis address', {
      fallback: prefill(env, 'REDIS_URL') || LOCAL_REDIS.url,
      validate: validators.redisUrl,
      hint: 'Looks like redis://host:6379, or redis://default:password@host:6379 for a hosted one. If using Upstash, use the TCP URL (redis://), not the REST URL (https://).',
    });
    save({ REDIS_URL: url });
    const check = await checkLive('Saying hello to Redis…', 'redis', env, (d) => `Short-term memory ready ${ui.dim(d)}`);
    if (check.ok) return;
    console.log(ui.aside('No answer from there. If it is hosted, check the address is reachable from this machine (firewall, allowed IPs) and try again.'));
  }
}

// ── Step 4: optional abilities ───────────────────────────────────────────────

async function stepExtras(io, env, save, opts = {}) {
  beginStep(4, 'Optional abilities');

  const alreadyOn = fields.OPTIONAL_EXTRAS.filter((extra) => hasAll(env, extra.keys));
  if (alreadyOn.length) {
    console.log(ui.say('Already switched on:'));
    for (const extra of alreadyOn) console.log(ui.bullet(extra.title));
    console.log('');
  }

  const remaining = fields.OPTIONAL_EXTRAS.filter((extra) => !hasAll(env, extra.keys));
  if (!remaining.length) {
    console.log(ui.ok('Everything optional is already set up.'));
    return;
  }

  console.log(ui.say('Rumi works without any of these. Each one adds something a teacher would notice, and you can add them later by running `rumi setup` again — so skipping is a real answer, not a postponement.'));

  const choice = await io.select('Add any now?', [
    { value: 'skip', label: 'Skip — get Rumi talking first', hint: 'Recommended. You can come back to this in two minutes.' },
    { value: 'add', label: `Go through them (${remaining.length})`, hint: 'Press Enter on any you do not want.' },
  ], opts.reconfigure ? 'add' : 'skip');

  if (choice === 'skip') return;

  for (const extra of remaining) {
    console.log('');
    console.log(`  ${ui.paint('brandHi', extra.title)}`);
    console.log(ui.aside(extra.why));
    console.log(ui.aside(`Get a key: ${extra.where}`));
    const collected = {};
    for (const key of extra.keys) {
      // The label is the env var only for the odd second field (a region, say)
      // where there is no plainer name for it than the thing itself.
      const label = key === extra.keys[0] ? 'Key' : key.replace(/_/g, ' ').toLowerCase();
      // extra.secret may be a bare boolean (masks only the first key — the
      // shape every single-secret extra uses today) or an array naming which
      // keys are actually sensitive (an entry with MULTIPLE real secrets,
      // e.g. Slack's signing secret AND bot token, both of which must never
      // echo to the terminal — masking only the first would silently type
      // the second one in the clear).
      const isSecret = Array.isArray(extra.secret) ? extra.secret.includes(key) : Boolean(extra.secret) && key === extra.keys[0];
      // eslint-disable-next-line no-await-in-loop -- one question at a time, by design
      const value = await io.ask(label, { secret: isSecret, fallback: prefill(env, key) });
      if (!value) break;
      collected[key] = value;
    }
    if (Object.keys(collected).length === extra.keys.length) {
      save(collected);
      console.log(ui.ok(`${extra.title} — on`));
    } else {
      console.log(ui.dim('  skipped'));
    }
  }
}

// ── Step 5: WhatsApp ─────────────────────────────────────────────────────────

/**
 * The plain-language channel question. The technical value (`CHANNEL_DRIVER`)
 * is decided behind it and never shown: "sandbox versus production driver" is
 * our vocabulary, and asking it of a user makes them guess at an architecture
 * they have no reason to know.
 *
 * The third answer is not a channel at all. WhatsApp is the only step here
 * that needs a second device in your hand, and someone setting Rumi up on a
 * laptop at a desk — or showing it to a room — may simply not have one.
 * Before this, the only way past the question was to start a pairing you could
 * not finish and wait out its timeout.
 *
 * @returns {Promise<'baileys'|'meta'|'skip'>}
 */
async function chooseChannelDriver(io) {
  return io.select('How are you using Rumi right now?', [
    {
      value: 'baileys',
      label: 'Just trying it out — link my own WhatsApp',
      hint: 'Two minutes, nothing to register. Works like WhatsApp Web.',
    },
    {
      value: 'meta',
      label: 'Real deployment — official WhatsApp Business number',
      hint: 'Needs a Meta Business account and their review process.',
    },
    {
      value: 'skip',
      label: 'Not right now — leave WhatsApp for later',
      hint: 'Rumi still runs, and still answers on Slack, Teams and Discord. Run `rumi pair` when you want WhatsApp.',
    },
  ], 'baileys');
}

const SANDBOX_CAVEATS = [
  'Rumi becomes a linked device on your own WhatsApp account, exactly like WhatsApp Web — so it can see and reply to your chats.',
  'Use a spare number or a second phone if that is not something you want.',
  'A few things are Meta-only and will feel plainer here: the tap-through forms, approved message templates, and the picture-menu carousels. Rumi asks the same questions as an ordinary chat instead, so nothing is blocked — but it is not the full experience.',
  'It is for trying Rumi out, not for a school: one personal account, and WhatsApp may disconnect it. Run `rumi graduate` for an official number as soon as you are past evaluating.',
];

async function linkSandbox(io) {
  console.log('');
  console.log(ui.say('Before you scan, two things worth knowing:'));
  for (const caveat of SANDBOX_CAVEATS) console.log(ui.bullet(caveat, { dim: true }));
  console.log('');

  const ready = await io.confirm('Ready to scan the code?', true);
  if (!ready) {
    console.log(ui.aside('No problem — run `rumi pair` whenever you are.'));
    return { linked: false };
  }

  console.log('');
  console.log(ui.say('On your phone: WhatsApp → Settings → Linked devices → Link a device, then point it at the code below.'));
  console.log('');

  const { linkWhatsApp, releaseWhatsApp } = require('./link-whatsapp');

  // The way out of a code you cannot scan.
  //
  // Pairing blocks for two and a half minutes waiting for a phone, and until
  // now the only key that did anything during it was Ctrl+C — which ends the
  // whole wizard. Someone at a desk with no second device had to sit through
  // the timeout or start over.
  //
  // The listener is attached from `onQr` rather than up front, so the offer
  // appears directly beneath the code it applies to, and a keystroke typed
  // while Rumi is still connecting is not quietly read as "give up".
  let giveUp;
  let abort;
  const skipped = new Promise((resolve, reject) => { giveUp = resolve; abort = reject; });

  let listener = null;
  const onQr = () => {
    if (listener) return; // WhatsApp re-issues a QR every ~20s; one offer is enough
    console.log(ui.dim('  No phone to hand? Press any key to skip — `rumi pair` links it later.'));
    listener = waitForAnyKey();
    // Ctrl+C is forwarded, not swallowed: it still ends the wizard, as it does
    // at every other question.
    listener.promise.then(() => giveUp({ ok: false, reason: 'skipped' }), abort);
  };

  let result;
  try {
    result = await Promise.race([linkWhatsApp({ onQr, cancel: skipped }), skipped]);
  } finally {
    if (listener) listener.cancel();
    await releaseWhatsApp();
  }

  if (result.reason === 'skipped') {
    console.log('');
    console.log(ui.aside('Skipped. Nothing else is affected — run `rumi pair` whenever you want WhatsApp linked.'));
    return { linked: false };
  }

  if (result.ok) {
    console.log('');
    console.log(ui.ok(`Linked${result.number ? ` as ${ui.bold(`+${result.number}`)}` : ''}`));
    return { linked: true, number: result.number };
  }

  const explanation = {
    timeout: 'Nothing was scanned in time.',
    'logged-out': 'WhatsApp rejected the session.',
    busy: 'Rumi already seems to be running, and two processes cannot share one WhatsApp session. Stop the other one first.',
  }[result.reason] || `Pairing failed: ${result.detail || 'unknown error'}`;
  console.log('');
  console.log(ui.warn(`${explanation} Everything else is saved — run \`rumi pair\` to try again.`));
  return { linked: false };
}

async function collectMetaCredentials(io, env, save) {
  console.log('');
  console.log(ui.say('Four values from Meta, all on one page.'));
  console.log('');
  console.log(ui.steps(fields.META_WALKTHROUGH));

  for (const field of fields.META_FIELDS) {
    console.log('');
    const existing = env[field.env] && !/^CHANGEME/i.test(env[field.env]) ? env[field.env] : '';
    // eslint-disable-next-line no-await-in-loop -- one question at a time, by design
    const value = await io.ask(field.label, {
      hint: field.hint,
      secret: Boolean(field.secret),
      fallback: existing || (field.generate ? field.generate() : ''),
      validate: field.validate,
    });
    save({ [field.env]: value });
  }

  const check = await checkLive('Asking Meta whether those work…', 'whatsapp', env, (d) => `Meta accepted your credentials ${ui.dim(d)}`);
  if (!check.ok) {
    console.log(ui.aside('Meta rejected them. The commonest cause is an access token that has expired — they last 24 hours unless you created a permanent one. Re-run `rumi setup --reconfigure` once you have a fresh token; everything else is saved.'));
  }
  return check.ok;
}

/**
 * Is the channel in `.env` already usable? Answering this is what keeps a
 * re-run from offering to re-pair a WhatsApp that is working perfectly well —
 * and re-pairing is not harmless: scanning a new code while the bot holds the
 * session is how a session gets invalidated.
 *
 * @returns {Promise<{number?: string|null, detail?: string}|null>} null when it is not
 */
async function channelAlreadyWorking(env, channel) {
  if (channel === 'meta') {
    if (!hasAll(env, ['WHATSAPP_TOKEN', 'PHONE_NUMBER_ID'])) return null;
    const check = await probe('whatsapp', env);
    return check.ok ? { detail: check.detail } : null;
  }
  const { sandboxIdentity } = require('./status');
  const identity = sandboxIdentity(env);
  return identity.paired ? { number: identity.number } : null;
}

async function stepChannel(io, env, save, opts = {}) {
  beginStep(5, 'Connecting WhatsApp');

  // Only an explicit CHANNEL_DRIVER counts as "already chosen" — the runtime
  // infers a default when it is unset, and inheriting that silently would skip
  // the one question this step exists to ask.
  const existing = isProvided(env, 'CHANNEL_DRIVER') ? env.CHANNEL_DRIVER.trim().toLowerCase() : '';
  if (existing && !opts.reconfigure) {
    const spin = ui.spinner('Checking the WhatsApp connection you already have…');
    const working = await channelAlreadyWorking(env, existing);
    if (working) {
      spin.succeed(working.number
        ? `WhatsApp already linked as ${ui.bold(`+${working.number}`)}`
        : `WhatsApp already connected ${ui.dim(working.detail || '')}`);
      return { channel: existing, linked: true, number: working.number };
    }
    spin.stop();
  }

  const channel = await chooseChannelDriver(io);

  // "Later" still has to leave a working deployment behind. The sandbox's
  // settings are written anyway — Rumi boots, the other channels work, and
  // `rumi pair` has somewhere to put the session when they come back — but
  // nothing is paired and no code is drawn.
  if (channel === 'skip') {
    save({
      CHANNEL_DRIVER: 'baileys',
      QUEUE_DRIVER: 'bullmq',
      CHANNEL_STATE_DIR: env.CHANNEL_STATE_DIR || '.channel-state',
    });
    console.log('');
    console.log(ui.aside('Left for later. Everything else is set up — run `rumi pair` when you have a phone to hand.'));
    return { channel: 'baileys', linked: false, skipped: true };
  }

  const vars = { CHANNEL_DRIVER: channel };

  // The async pipeline (quiz reports, coaching, video) needs a queue, and the
  // template's default is `sqs` — an AWS account a sandbox user does not have.
  // Seen live: a quiz that generated AND delivered still told the teacher
  // "something went wrong", because scheduling its report threw "SQS Queue not
  // configured". bullmq runs on the Redis collected in step 3, so it is the
  // only sensible sandbox default. Production keeps its own queue choice.
  if (channel !== 'meta') {
    vars.QUEUE_DRIVER = 'bullmq';
    vars.CHANNEL_STATE_DIR = env.CHANNEL_STATE_DIR || '.channel-state';
  }
  save(vars);

  if (channel === 'meta') {
    await collectMetaCredentials(io, env, save);
    return { channel, linked: false };
  }
  const outcome = await linkSandbox(io);
  return { channel, ...outcome };
}

// ── Step 6: additional messaging channels (Slack, later Discord) ────────────

/**
 * Walks the Slack app-configuration checklist one screen at a time, in the
 * exact order the app's own sidebar is laid out — Press Enter to move from
 * each section to the next, rather than a single screen listing every
 * requirement at once.
 *
 * This exists because the alternative (discover each requirement from a live
 * failure — Socket Mode, then App Home, then a missing scope, then another
 * missing scope) is what actually happened testing this by hand: eight
 * separate rounds of trial and error, each one a different error message with
 * no indication of what else was still missing. One section per screen, done
 * in order with nothing to skip ahead to, turns that into one pass.
 */
async function walkSlackAppConfig(io, baseUrl) {
  const urls = fields.slackRequestUrls(baseUrl);

  console.log('');
  console.log(ui.say('Slack apps are configured on Slack\'s own site — nothing here can do that part for you. This walks through it one section at a time, in the order Slack\'s own sidebar lists them.'));
  console.log('');
  console.log(ui.bold('  1. Create the app'));
  console.log(ui.steps(fields.SLACK_APP_WALKTHROUGH_INTRO));
  await io.pressEnter('Press Enter once the app exists and Socket Mode is off');

  console.log('');
  console.log(ui.bold('  2. Bot Token Scopes') + ui.dim('  (OAuth & Permissions → Scopes → Bot Token Scopes)'));
  console.log(ui.say('Click "Add an OAuth Scope" and add each of these:'));
  console.log(ui.box(fields.SLACK_BOT_SCOPES, { role: 'accent' }));
  await io.pressEnter('Press Enter once all five scopes are added');

  console.log('');
  console.log(ui.bold('  3. Event Subscriptions'));
  console.log(ui.steps([
    'Turn Event Subscriptions on',
    'Set the Request URL below',
    'Under "Subscribe to bot events", add: message.im — this one event covers both plain messages and file/voice uploads in a DM',
  ]));
  console.log(ui.box([urls.events], { title: 'Request URL', role: 'accent' }));
  await io.pressEnter('Press Enter once the Request URL is verified and message.im is subscribed');

  console.log('');
  console.log(ui.bold('  4. Interactivity & Shortcuts'));
  console.log(ui.steps([
    'Turn Interactivity on',
    'Set the Request URL below',
  ]));
  console.log(ui.box([urls.interactions], { title: 'Request URL', role: 'accent' }));
  await io.pressEnter('Press Enter once that Request URL is saved');

  console.log('');
  console.log(ui.bold('  5. Slash Commands'));
  console.log(ui.say('Add each of these as its own Slash Command, every one pointing at the same Request URL:'));
  console.log(ui.box([urls.commands], { title: 'Request URL (same one, every time)', role: 'accent' }));
  // Slack rejects its own reserved words outright ("is a reserved word") the
  // moment you try to add them, no matter the Request URL. Skip them here
  // rather than sending the user into a wall; both still work on every other
  // channel, and /status has a natural-language alternative on Slack
  // ("my status" / "show status" / "what's running").
  const slackAddableCommands = fields.SLACK_SLASH_COMMANDS
    .filter((cmd) => !fields.SLACK_RESERVED_COMMANDS.includes(cmd));
  console.log(ui.table(slackAddableCommands.map((cmd) => [cmd, ''])));
  console.log(ui.aside('/readingtest is one word — Slack command names cannot contain a space.'));
  console.log(ui.aside('/status is skipped — Slack reserves that name and refuses to register it. Teachers reach the same feature on Slack by typing "my status" instead.'));
  console.log(ui.aside('/help is skipped for the same reason — Slack reserves it. Teachers on Slack reach the feature list with /menu instead.'));
  await io.pressEnter(`Press Enter once all ${slackAddableCommands.length} commands are added`);

  console.log('');
  console.log(ui.bold('  6. Install the app'));
  console.log(ui.steps([
    'Go to OAuth & Permissions',
    'Click "Install to Workspace" (or "Reinstall" if you changed scopes after installing once already)',
  ]));
  await io.pressEnter('Press Enter once it is installed — the next two questions come from that page');
}

/**
 * Walks the Discord application-configuration checklist, mirroring
 * walkSlackAppConfig's one-section-at-a-time shape — but shorter: Discord's
 * setup has no Request-URL-per-feature concept to configure at all, since
 * this bot uses Discord's Gateway (a persistent connection) rather than a
 * signed HTTP endpoint. Ends with registering the 9 slash commands directly
 * (a REST call this wizard can make itself, unlike Slack's manual
 * app-config-UI step for each command).
 */
async function walkDiscordAppConfig(io) {
  console.log('');
  console.log(ui.say('Discord apps are configured on Discord\'s own site too — this walks through it one section at a time.'));
  console.log('');
  console.log(ui.bold('  1. Create the application'));
  console.log(ui.steps([
    'Open https://discord.com/developers/applications → New Application',
    'Give it any name',
  ]));
  await io.pressEnter('Press Enter once the application exists');

  console.log('');
  console.log(ui.bold('  2. Bot token'));
  console.log(ui.steps(['Bot tab → Reset Token → copy it (this is the value the next question asks for)']));
  await io.pressEnter('Press Enter once you have copied the token');

  console.log('');
  console.log(ui.bold('  3. Privileged Gateway Intents'));
  console.log(ui.steps([
    'Bot tab → Privileged Gateway Intents → enable "Message Content Intent"',
  ]));
  console.log(ui.aside('Self-togglable with no review while the bot is in under 100 servers — Discord requires its own Bot Verification above that threshold.'));
  await io.pressEnter('Press Enter once Message Content Intent is enabled');

  console.log('');
  console.log(ui.bold('  4. Invite the bot to a server'));
  console.log(ui.steps([
    'OAuth2 → URL Generator → scopes: bot, applications.commands',
    'Bot Permissions: Send Messages, Read Message History, Attach Files, Use Slash Commands, Embed Links',
    'Copy the generated URL, open it, and add the bot to a test server',
  ]));
  await io.pressEnter('Press Enter once the bot is in a server');

  console.log('');
  console.log(ui.bold('  5. Application ID'));
  console.log(ui.steps(['General Information tab → copy the Application ID (this is the value the question after next asks for)']));
  await io.pressEnter('Press Enter once you have copied the Application ID');
}

async function stepMessagingChannels(io, env, save, opts = {}) {
  beginStep(6, 'Other places teachers can reach Rumi');

  const slackConfigured = hasAll(env, ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET']);
  if (slackConfigured && !opts.reconfigure) {
    const check = await checkLive('Checking the Slack connection you already have…', 'slack', env, (d) => `Slack already connected ${ui.dim(d)}`);
    if (check.ok) return { slack: true, ...(await stepDiscordChannel(io, env, save, opts)) };
    console.log(ui.say('That token is not working. Let\'s set Slack up again.'));
  }

  // Deliberately not "WhatsApp is set up" — WhatsApp can be skipped now, and a
  // closing line that assumes it was done is the kind of small lie that makes
  // a user distrust everything else the wizard tells them.
  console.log(ui.say('A teacher can also reach Rumi on Slack, at the same time, on the same account — nobody has to choose.'));
  console.log('');

  const wantsSlack = await io.confirm('Also connect Slack?', false);
  if (!wantsSlack) return { slack: false, ...(await stepDiscordChannel(io, env, save, opts)) };

  const baseUrl = await io.ask('Public URL Slack should send requests to', {
    hint: 'The https address your bot is reachable at — an ngrok URL while testing locally (run `ngrok http <port>` in another terminal), or your deployed address in production.',
    validate: (input) => {
      const value = String(input || '').trim().replace(/\/+$/, '');
      if (!value) return { ok: false, reason: 'This can\'t be empty.' };
      if (!/^https:\/\//.test(value)) return { ok: false, reason: 'Slack requires https:// — an http:// or bare host will be rejected when you try to save it.' };
      return { ok: true, value };
    },
  });

  await walkSlackAppConfig(io, baseUrl);

  for (;;) {
    const signingSecret = await io.ask('Signing Secret', {
      secret: true,
      fallback: prefill(env, 'SLACK_SIGNING_SECRET'),
      hint: 'Basic Information → App Credentials → Signing Secret.',
    });
    const botToken = await io.ask('Bot User OAuth Token', {
      secret: true,
      fallback: prefill(env, 'SLACK_BOT_TOKEN'),
      hint: 'OAuth & Permissions → Bot User OAuth Token — starts with xoxb-.',
    });

    save({ SLACK_SIGNING_SECRET: signingSecret, SLACK_BOT_TOKEN: botToken });
    const check = await checkLive('Checking the token and its scopes…', 'slack', env, (d) => `Slack connected ${ui.dim(d)}`);
    if (check.ok) return { slack: true, ...(await stepDiscordChannel(io, env, save, opts)) };
    console.log(ui.aside(check.detail));
    const retry = await io.confirm('Try those two values again?', true);
    if (!retry) return { slack: false, ...(await stepDiscordChannel(io, env, save, opts)) };
  }
}

/**
 * Discord's own confirm-then-configure-then-live-check block, structurally
 * identical to the Slack block above but run as its own function — Discord
 * is independent of Slack (a teacher's account can have neither, either, or
 * both), so this always runs regardless of the Slack outcome above it.
 */
async function stepDiscordChannel(io, env, save, opts = {}) {
  const discordConfigured = hasAll(env, ['DISCORD_BOT_TOKEN', 'DISCORD_APPLICATION_ID']);
  if (discordConfigured && !opts.reconfigure) {
    const check = await checkLive('Checking the Discord connection you already have…', 'discord', env, (d) => `Discord already connected ${ui.dim(d)}`);
    if (check.ok) return { discord: true };
    console.log(ui.say('That token is not working. Let\'s set Discord up again.'));
  }

  console.log('');
  console.log(ui.say('A teacher can also reach Rumi on Discord, at the same time as WhatsApp and Slack — nobody has to choose.'));
  console.log('');

  const wantsDiscord = await io.confirm('Also connect Discord?', false);
  if (!wantsDiscord) return { discord: false };

  await walkDiscordAppConfig(io);

  for (;;) {
    const botToken = await io.ask('Bot Token', {
      secret: true,
      fallback: prefill(env, 'DISCORD_BOT_TOKEN'),
      hint: 'Bot tab → Reset Token.',
    });
    const applicationId = await io.ask('Application ID', {
      fallback: prefill(env, 'DISCORD_APPLICATION_ID'),
      hint: 'General Information tab.',
    });

    save({ DISCORD_BOT_TOKEN: botToken, DISCORD_APPLICATION_ID: applicationId });
    const check = await checkLive('Checking the bot token…', 'discord', env, (d) => `Discord connected ${ui.dim(d)}`);
    if (check.ok) {
      const spin = ui.spinner('Registering the 9 slash commands…');
      try {
        const { registerDiscordCommands } = require('./discord-register-commands');
        const result = await registerDiscordCommands({ token: botToken, applicationId, guildId: env.DISCORD_TEST_GUILD_ID });
        spin.succeed(`Registered ${result.registered} slash commands (${result.guildScoped ? 'guild-scoped, instant' : 'global, up to ~1hr to propagate'})`);
      } catch (err) {
        spin.fail(ui.paint('danger', `Slash command registration failed: ${err.message}`));
        console.log(ui.aside('You can retry later with `npm run discord:register-commands`.'));
      }
      return { discord: true };
    }
    console.log(ui.aside(check.detail));
    const retry = await io.confirm('Try those two values again?', true);
    if (!retry) return { discord: false };
  }
}

// ── Step 7: Switch ───────────────────────────────────────────────────────────

/**
 * Switch is the odd one out among the channels, and the difference is worth
 * stating before the questions start: Slack and Discord each connect Rumi to
 * ONE app, while Switch is a server that bridges Slack, Teams, Discord,
 * Telegram and Mattermost itself. Rumi speaks one protocol to it and reaches
 * all five — and, unlike the others, joins ROOMS where people and other
 * agents work together rather than a one-to-one chat with a bot.
 *
 * Two HTTP calls, and the second is the one people miss. Registering an agent
 * leaves it addressable only by its owner, so every teacher who is not you
 * gets "You're not permitted to direct messages to me in this room" while the
 * agent's own logs say nothing at all. Opening that policy needs operator
 * credentials, because an agent may not change its own.
 */
async function stepSwitchChannel(io, env, save, opts = {}) {
  const configured = hasAll(env, ['SWITCH_BRIDGE_URL', 'SWITCH_AGENT_ID', 'SWITCH_AGENT_API_KEY']);
  if (configured && !opts.reconfigure) {
    const check = await checkLive('Checking the Switch server you already have…', 'switchServer', env, (d) => `Switch already connected ${ui.dim(d)}`);
    if (check.ok) return { switch: true };
    console.log(ui.say('That connection is not working. Let\'s set Switch up again.'));
  }

  console.log('');
  console.log(ui.say('Switch (switchagents.ai) is a server you run yourself that puts Rumi in shared rooms alongside your team — and bridges those rooms into Slack, Teams, Discord, Telegram or Mattermost. One connection, every platform.'));
  console.log(ui.aside('Skip this if you are not running a Switch server. Nothing else depends on it.'));
  console.log('');

  const wants = await io.confirm('Connect Rumi to a Switch server?', false);
  if (!wants) return { switch: false };

  const bridgeUrl = await io.ask('Switch API address', {
    hint: 'The agent bridge, usually port 8000 — NOT the Gateway on 3000. If GET <url>/health returns {"status":"ok"}, it is the right one.',
    fallback: prefill(env, 'SWITCH_BRIDGE_URL') || 'http://127.0.0.1:8000',
    validate: (input) => {
      const value = String(input || '').trim().replace(/\/+$/, '');
      if (!value) return { ok: false, reason: 'This can\'t be empty.' };
      if (!/^https?:\/\//.test(value)) return { ok: false, reason: 'Needs to start with http:// or https://.' };
      return { ok: true, value };
    },
  });

  const spin = ui.spinner('Looking for the server…');
  try {
    const health = await fetch(`${bridgeUrl}/health`);
    if (!health.ok) {
      spin.fail(ui.paint('danger', health.status === 401
        ? 'That answered 401 — it looks like the Gateway address rather than the agent bridge.'
        : `That answered HTTP ${health.status}.`));
      return { switch: false };
    }
    spin.succeed('Switch server found');
  } catch (err) {
    spin.fail(ui.paint('danger', `Could not reach it: ${err.message}`));
    return { switch: false };
  }

  const regToken = await io.ask('Registration token', {
    secret: true,
    hint: 'AGENT_REGISTRATION_TOKEN from the Switch server\'s environment. It registers agents and is rejected everywhere else — not the same thing as the key Rumi will use afterwards.',
  });
  const agentName = await io.ask('Name teachers will use to address Rumi', {
    fallback: prefill(env, 'SWITCH_AGENT_NAME') || 'rumi',
    hint: 'They type @<this>. Avoid a name the messaging app already uses for a bot — the app wins that collision and the mention never reaches Switch.',
  });

  const regSpin = ui.spinner(`Registering "${agentName}"…`);
  let agent;
  try {
    const res = await fetch(`${bridgeUrl}/agents`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${regToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: agentName,
        description: 'Rumi — AI teaching assistant. Lesson plans, classroom coaching, reading assessment.',
        connector_type: 'Rumi Platform',
        // always_on: Rumi is a service, reachable independent of any room,
        // rather than a session somebody launches.
        integration_profile: {
          connection_model: 'always_on',
          message_exchange: true,
          pre_invocation_mediation: [],
          post_invocation_mediation: [],
          event_reporting: [],
        },
        metadata: { product: 'rumi-platform' },
        overwrite: true,
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      regSpin.fail(ui.paint('danger', `Registration refused (HTTP ${res.status}): ${text.slice(0, 160)}`));
      return { switch: false };
    }
    agent = JSON.parse(text);
    regSpin.succeed(`Registered as "${agentName}"`);
  } catch (err) {
    regSpin.fail(ui.paint('danger', `Registration failed: ${err.message}`));
    return { switch: false };
  }

  // The API key is returned exactly once; there is no route that reads it back.
  save({
    SWITCH_BRIDGE_URL: bridgeUrl,
    SWITCH_AGENT_ID: agent.id,
    SWITCH_AGENT_API_KEY: agent.api_key,
    SWITCH_AGENT_NAME: agentName,
  });

  console.log('');
  console.log(ui.say('One more thing, and it is the step people miss: a new agent can only be addressed by its owner. Every other teacher gets "You\'re not permitted to direct messages to me in this room", and nothing in Rumi\'s logs explains why.'));
  console.log(ui.aside('Opening it needs the Switch operator login, because an agent cannot change its own permissions.'));
  console.log('');

  const openIt = await io.confirm('Let any teacher in the room address Rumi?', true);
  if (!openIt) {
    console.log(ui.aside('Left as owner-only. Change it later in Switch Console: Agents → ' + agentName + ' → addressing.'));
    return { switch: true };
  }

  const email = await io.ask('Switch operator email', { fallback: prefill(env, 'SWITCH_GATEWAY_EMAIL') });
  const password = await io.ask('Switch operator password', { secret: true });

  const polSpin = ui.spinner('Opening the addressing policy…');
  try {
    const login = await fetch(`${bridgeUrl}/gateway/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!login.ok) throw new Error(`sign-in refused (HTTP ${login.status})`);
    const cookie = (login.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');

    // policy: null CLEARS the policy, which is what "open to anyone" is.
    const res = await fetch(`${bridgeUrl}/gateway/agents/${agent.id}/addressing-policy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ policy: null }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    polSpin.succeed('Anyone in the room can now address Rumi');
  } catch (err) {
    polSpin.warn(`Could not open it (${err.message})`);
    console.log(ui.aside(`Rumi is registered and will connect, but only you can address it until you fix this in Switch Console: Agents → ${agentName} → addressing → anyone.`));
  }

  const check = await checkLive('Checking the connection…', 'switchServer', env, (d) => `Switch connected ${ui.dim(d)}`);
  return { switch: check.ok };
}

// ── Screens ──────────────────────────────────────────────────────────────────

function welcome(env) {
  console.log(ui.logo('An AI teaching companion that lives in WhatsApp'));
  console.log(ui.say('This sets Rumi up on your own accounts, start to finish. It takes about fifteen minutes, most of which is waiting for a database to start.'));
  console.log('');
  console.log(ui.bold('  You will need'));
  console.log(ui.bullet('A free Supabase account — where Rumi remembers things'));
  console.log(ui.bullet('An OpenRouter account with a few dollars of credit — how Rumi thinks'));
  console.log(ui.bullet('WhatsApp on your phone'));
  console.log('');
  console.log(ui.bold('  Good to know'));
  console.log(ui.bullet('Each answer is saved as you go. Press Ctrl+C to stop and run `rumi setup` again to carry on.'));
  console.log(ui.bullet('Keys are hidden while you type, and stay on this machine in a file called .env.'));

  const done = ['SUPABASE_URL', 'OPENROUTER_API_KEY', 'REDIS_URL'].filter((key) => isProvided(env, key));
  if (done.length) {
    console.log('');
    console.log(ui.say(`Picking up from last time — ${done.length} of 3 core services are already configured, so this will be quick.`));
  }
}

async function finish(env, channelResult) {
  const { channel, number, linked, slack, discord } = channelResult;
  console.log('');
  console.log(ui.rule());
  const spin = ui.spinner('One last check of everything…');
  const { runDoctor } = require('./doctor');
  const doctor = await runDoctor({ env });
  spin.stop();

  console.log(ui.logo());
  const headline = doctor.ok
    ? ui.paint('brand', 'Rumi is ready.', { bold: true })
    : ui.paint('accent', 'Rumi is set up, with something still to fix.', { bold: true });
  console.log(`  ${headline}`);
  console.log('');
  console.log(summary.renderReadiness(doctor, { number, linked }));
  console.log('');
  console.log(ui.rule());
  console.log('');
  console.log(summary.renderNextSteps({ channel, number, slack, discord }));
  console.log('');
  if (!doctor.ok) {
    console.log(ui.aside('Run `rumi doctor` for the detail on what is not working yet.'));
    console.log('');
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main(argv = process.argv) {
  try { require('dotenv').config({ path: ENV_PATH, quiet: true }); } catch { /* dotenv optional */ }

  const reconfigure = argv.includes('--reconfigure') || argv.includes('--force');
  const env = { ...process.env, ...readEnvFile(ENV_PATH) };
  const save = createSaver(env);
  const io = createIo();
  const opts = { reconfigure };

  // Handled here rather than at the process entry point, because the wizard is
  // launched two ways (`rumi setup` and `node interactive-setup.js`) and a
  // goodbye that only works one of them is how Ctrl+C ended up printing a bare
  // "Cancelled by user" stack-trace line through the CLI.
  try {
    welcome(env);
    console.log('');
    await io.pressEnter('Press Enter to begin');

    await stepDatabase(io, env, save, opts);
    finishStep('Where Rumi keeps its memory');
    await stepBrain(io, env, save, opts);
    finishStep('How Rumi thinks');
    await stepMemory(io, env, save, opts);
    finishStep("Rumi's short-term memory");
    await stepExtras(io, env, save, opts);
    finishStep('Optional abilities');
    const channelResult = await stepChannel(io, env, save, opts);
    finishStep('Connecting WhatsApp');
    const messagingResult = await stepMessagingChannels(io, env, save, opts);
    finishStep('Other places teachers can reach Rumi');
    const switchResult = await stepSwitchChannel(io, env, save, opts);

    await finish(env, { ...channelResult, ...messagingResult, ...switchResult });
  } catch (err) {
    if (err instanceof PromptAbortError || err.aborted) {
      console.log('');
      console.log(ui.say('Stopped. Everything you answered is saved — run `rumi setup` again to carry on from here.'));
      process.exitCode = 130;
      return;
    }
    console.log('');
    console.log(ui.fail(`Setup could not finish: ${err.message}`));
    console.log(ui.aside('Nothing already saved was lost. `rumi doctor` shows where things stand.'));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().then(() => process.exit(process.exitCode || 0));
}

module.exports = {
  main, welcome, finish,
  stepDatabase, stepBrain, stepMemory, stepExtras, stepChannel, stepMessagingChannels, stepDiscordChannel,
  stepSwitchChannel, LLM_PROVIDERS,
  ensureTables, chooseChannelDriver, collectMetaCredentials, linkSandbox, channelAlreadyWorking,
  createSaver, hasAll, isProvided, prefill, isTemplateSuggestion, startLocalRedis, dockerAvailable, probe,
  beginStep, finishStep, walkSlackAppConfig, walkDiscordAppConfig,
  TOTAL_STEPS, LOCAL_REDIS,
};
