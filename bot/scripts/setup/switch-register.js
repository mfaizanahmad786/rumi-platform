#!/usr/bin/env node
/**
 * Registers Rumi as an agent on a Switch server and prints the three env vars
 * the channel needs.
 *
 *   node bot/scripts/setup/switch-register.js [--bridge http://127.0.0.1:8000]
 *
 * Two steps, and the SECOND one is the one nobody expects:
 *
 *   1. POST /agents — register, and receive {id, api_key}. The api_key comes
 *      back exactly once; there is no route that re-reads it.
 *
 *   2. Open the agent's ADDRESSING POLICY via the Gateway. A newly registered
 *      agent does not start open — it starts on `default_agent_policy`, which
 *      admits only its owner and that owner's other agents. Rumi's whole
 *      point is that any teacher in the room can @ it, and every one of them
 *      is somebody other than the owner. Skip this step and the symptom is
 *      silent and very confusing: the message reaches the agent's stream with
 *      `addressed: false`, while the teacher sees Switch answer on Rumi's
 *      behalf with "You're not permitted to direct messages to me in this
 *      room". Nothing in the agent's own logs says why.
 *
 * Step 2 needs Gateway credentials because an agent may not change its own
 * addressing policy — the route is owner-or-admin only, by design.
 *
 * Not /agents/register-known: that route is for the CLI providers Switch
 * Console launches (claude-code, codex, opencode, antigravity). Rumi is a
 * long-running service, which is what `always_on` describes, so it registers
 * through the lower-level route with a full integration profile.
 */

const readline = require('readline');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BRIDGE = (arg('--bridge', process.env.SWITCH_BRIDGE_URL) || 'http://127.0.0.1:8000').replace(/\/+$/, '');
const AGENT_NAME = arg('--name', process.env.SWITCH_AGENT_NAME) || 'rumi';

function ask(question, { silent = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    if (silent) {
      // Suppress echo for the password prompt.
      const onData = (char) => {
        if (['\n', '\r', ''].includes(String(char))) process.stdin.removeListener('data', onData);
        else process.stdout.write('\x1B[2K\x1B[200D' + question + '*'.repeat(rl.line.length));
      };
      process.stdin.on('data', onData);
    }
    rl.question(question, (answer) => {
      rl.close();
      if (silent) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function http(url, { method = 'GET', body, headers = {}, jar } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(jar?.cookie ? { Cookie: jar.cookie } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: 'manual',
  });
  if (jar) {
    const setCookie = res.headers.getSetCookie?.() || [];
    if (setCookie.length) jar.cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  }
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) {
    const error = new Error(`${method} ${url} -> ${res.status}: ${String(text).slice(0, 300)}`);
    error.status = res.status;
    throw error;
  }
  return parsed;
}

async function main() {
  console.log(`\nSwitch bridge: ${BRIDGE}`);

  // /health is public and is the correct probe for "is this the bridge base
  // URL". A 401 here means the right host and the wrong path — most often the
  // Gateway URL, which is a different address agents cannot use.
  try {
    await http(`${BRIDGE}/health`);
    console.log('✅ bridge reachable\n');
  } catch (error) {
    console.error(`❌ ${BRIDGE}/health failed: ${error.message}`);
    console.error('   A 401 usually means this is the Gateway URL, not the agent bridge URL.');
    process.exit(1);
  }

  const regToken = process.env.SWITCH_REGISTRATION_TOKEN
    || await ask('AGENT_REGISTRATION_TOKEN (from the Switch server\'s env): ', { silent: true });
  if (!regToken) { console.error('A registration token is required.'); process.exit(1); }

  // ── 1. Register ───────────────────────────────────────────────────────────
  let agent;
  try {
    agent = await http(`${BRIDGE}/agents`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${regToken}` },
      body: {
        name: AGENT_NAME,
        description: 'Rumi — AI teaching assistant. Lesson plans, classroom coaching, reading assessment, quizzes and attendance.',
        connector_type: 'Rumi Platform',
        integration_profile: {
          // always_on: Rumi is reachable independent of any room, because it
          // is a service rather than a session somebody launches.
          connection_model: 'always_on',
          message_exchange: true,
          pre_invocation_mediation: [],
          post_invocation_mediation: [],
          event_reporting: [],
        },
        metadata: { product: 'rumi-platform' },
        overwrite: true,
      },
    });
  } catch (error) {
    if (error.status === 409) {
      console.error(`❌ An agent named "${AGENT_NAME}" already exists. Re-run with --name <other>, or`);
      console.error('   delete it in Switch Console first. Its API key cannot be read back.');
    } else {
      console.error(`❌ registration failed: ${error.message}`);
    }
    process.exit(1);
  }
  console.log(`✅ registered "${AGENT_NAME}" -> ${agent.id}`);

  // ── 2. Open the addressing policy ─────────────────────────────────────────
  console.log('\nNow opening the addressing policy so any teacher in a room can @rumi.');
  console.log('This needs Gateway (operator) credentials — an agent may not change its own.\n');

  const email = process.env.SWITCH_GATEWAY_EMAIL || await ask('Gateway admin email: ');
  const password = process.env.SWITCH_GATEWAY_PASSWORD || await ask('Gateway admin password: ', { silent: true });

  const jar = {};
  let policyOpened = false;
  try {
    await http(`${BRIDGE}/gateway/auth/login`, { method: 'POST', body: { email, password }, jar });
    // policy: null CLEARS the policy, which is what "open to anyone" is.
    await http(`${BRIDGE}/gateway/agents/${agent.id}/addressing-policy`, {
      method: 'PUT', body: { policy: null }, jar,
    });
    policyOpened = true;
    console.log('✅ addressing policy cleared — anyone in the room may address Rumi');
  } catch (error) {
    console.warn(`⚠️  could not open the addressing policy: ${error.message}`);
    console.warn('   Rumi is registered and will connect, but teachers who are not its owner');
    console.warn('   will be refused with "You\'re not permitted to direct messages to me in');
    console.warn('   this room", and the agent will see addressed:false. Fix it in Switch');
    console.warn(`   Console (Agents -> ${AGENT_NAME} -> addressing: anyone), or re-run this script.`);
  }

  console.log('\n─────────────────────────────────────────────────────────────');
  console.log('Add these to your .env — the API key is shown ONCE:\n');
  console.log(`SWITCH_BRIDGE_URL=${BRIDGE}`);
  console.log(`SWITCH_AGENT_ID=${agent.id}`);
  console.log(`SWITCH_AGENT_API_KEY=${agent.api_key}`);
  console.log('\n─────────────────────────────────────────────────────────────');
  if (!policyOpened) console.log('⚠️  remember the addressing policy warning above.');
  console.log('Then invite Rumi into a room from your messaging app, and say hello.\n');
}

main().catch((error) => { console.error(`FATAL: ${error.message}`); process.exit(1); });
