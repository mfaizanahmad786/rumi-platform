/**
 * Switch connection manager — the ONE place that owns the agent-protocol
 * connection to a Switch server. Mirrors discord-connection.js's role (a
 * single shared connection exposed via getters, lifecycle on `events`), but
 * the protocol underneath is unusual enough to be worth stating plainly:
 *
 *   Down: one SSE stream.  Up: ordinary HTTP.  That is the whole transport.
 *
 * There is no handshake and no SDK. Opening the event stream IS what creates
 * the connection, and a client-generated connection id — reused across every
 * reopen — is what makes that connection survive a dropped socket. See
 * switch-reference/docs/official/internals/agent-protocol.md.
 *
 * ── Why this file holds the connection id, and why workers must not ──────────
 * Reopening a live connection id is a TAKEOVER: the superseded stream is
 * terminated with an `evicted` frame. Two processes sharing one id fight,
 * each evicting the other on every reconnect. Rumi runs background workers
 * (lesson-plan generation, coaching reports) in separate processes, so those
 * must NEVER call connect().
 *
 * They do not need to. Switch's send routes are stateless HTTP — see
 * ensureConfig() below — so a worker posts directly with the API key and
 * opens no stream at all. That is why there is no outbound relay here: the
 * Matrix channel in upstream PR #104 needed one (matrix-outbound-relay.js,
 * ~270 lines over Redis) because matrix-bot-sdk cannot send without a sync
 * connection and a crypto store. Nothing in this channel has that
 * constraint, so the split is simply "connect() is the bot's; sends are
 * anyone's", enforced by tests/messaging/switch-worker-send.test.js.
 *
 * ── No new dependency ────────────────────────────────────────────────────────
 * Node 20+ ships fetch and web streams, which is the entire client surface
 * this protocol needs. Nothing is added to package.json, and nothing is
 * required until connect() is actually called — matching this repo's lazy
 * client convention (baileys-connection.js, discord-connection.js, r2.js).
 */

const EventEmitter = require('events');
const { randomUUID } = require('crypto');
const { logToFile } = require('../../utils/logger');

/**
 * The one place to observe connection lifecycle and inbound domain events —
 * mirrors baileys-connection.js's and discord-connection.js's own `events`.
 * switch-events.adapter.js is the only intended subscriber.
 */
const events = new EventEmitter();

// Beat cadence and TTL are DIFFERENT numbers on purpose (2s vs 6s), so one
// missed beat does not sweep the connection. The server states the cadence in
// its connection_state frame; this is only the fallback before we've read it.
const DEFAULT_BEAT_SECONDS = 2;

// Declared on the stream open URL so a Switch operator can tell which client
// is connected. bot/VERSION is a plain text file, not a module — read once at
// require time, and never fatal: an unreadable VERSION must not stop the bot
// connecting.
const CLIENT_VERSION = (() => {
  try {
    // eslint-disable-next-line global-require
    return require('fs').readFileSync(require('path').join(__dirname, '../../../VERSION'), 'utf-8').trim() || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// Generated once per process and reused for the life of it. Not per-connect:
// that is the whole point (see the takeover note above).
let connectionId = null;

let state = {
  connected: false,
  agentId: null,
  apiKey: null,
  bridgeUrl: null,
  cursor: 'head',
  rooms: [],
};

let beatTimer = null;
let abortController = null;
let shuttingDown = false;
let connectPromise = null;

function config(env = process.env) {
  return {
    bridgeUrl: (env.SWITCH_BRIDGE_URL || '').trim().replace(/\/+$/, ''),
    agentId: (env.SWITCH_AGENT_ID || '').trim(),
    apiKey: (env.SWITCH_AGENT_API_KEY || '').trim(),
  };
}

/**
 * Populates the credentials every HTTP call needs, from the environment, in
 * any process — whether or not this one owns the event stream.
 *
 * This is what lets a WORKER send. Lesson-plan PDFs, coaching reports,
 * reading results, videos and exam grading are all delivered from the
 * background worker, minutes after the request, through the same
 * WhatsAppService facade the bot uses. The worker has the same env but has
 * never called connect() — and must never call it, because reopening this
 * agent's connection id is a takeover that would evict the bot's stream with
 * an `evicted` frame and stop every teacher's messages arriving.
 *
 * It does not have to. Unlike Matrix — where the equivalent problem forced
 * upstream PR #104 to relay every worker send to the bot over Redis, because
 * matrix-bot-sdk cannot send without a sync connection and a crypto store —
 * Switch's send routes are ordinary stateless HTTP. `POST /agents/{id}/message`
 * and the media routes authenticate with the API key alone and take the room
 * as an argument; neither consults a connection. So the worker sends
 * directly, with no Redis hop, no carrying PDFs between processes as base64,
 * and no request/reply timeout to get wrong.
 *
 * The split that makes this safe is simply: connect() opens a stream and only
 * the bot calls it (via switch-events.adapter.js#attach, wired in
 * whatsapp-bot.js's PERSISTENT_CONNECTION_DRIVERS); every send path below
 * goes through here and opens nothing.
 */
function ensureConfig(env = process.env) {
  if (state.bridgeUrl && state.agentId && state.apiKey) return state;
  const cfg = config(env);
  if (!cfg.bridgeUrl || !cfg.agentId || !cfg.apiKey) {
    throw new Error(
      'Switch channel needs SWITCH_BRIDGE_URL, SWITCH_AGENT_ID and SWITCH_AGENT_API_KEY. '
      + 'Run `node bot/scripts/setup/switch-register.js` to create the agent and print all three.'
    );
  }
  state = { ...state, ...cfg };
  return state;
}

function isConnected() {
  return state.connected;
}

/**
 * The agent's id. Resolves from the environment when this process has never
 * connected, so a worker can address the media routes.
 */
function getAgentId() {
  if (!state.agentId) {
    try { ensureConfig(); } catch { return null; }
  }
  return state.agentId;
}

/** The rooms the server says this connection covers — its answer, not our request. */
function getRooms() {
  return [...state.rooms];
}

/**
 * One HTTP call against the agent bridge, always bearing the agent API key.
 *
 * The registration token is a DIFFERENT credential and is rejected here: an
 * API key will not register an agent, and a registration token will not open
 * a stream. Registration is out of band (scripts/setup/switch-register.js).
 */
async function api(path, { method = 'GET', body, headers = {} } = {}) {
  ensureConfig();
  const res = await fetch(`${state.bridgeUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${state.apiKey}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!res.ok) {
    const error = new Error(`Switch ${method} ${path} -> ${res.status}: ${String(text).slice(0, 300)}`);
    error.status = res.status;
    throw error;
  }
  return parsed;
}

/**
 * Invoke a Switch operation. The connection-id header is what the server
 * resolves the caller's current room from; an operation needing a room fails
 * without it. Arguments go in the body UNWRAPPED — not nested under a key.
 */
async function callOp(operation, args = {}) {
  const { agentId } = ensureConfig(); // before the template literal — see postMessage
  return api(`/agents/${agentId}/ops/${operation}`, {
    method: 'POST',
    body: args,
    headers: connectionId ? { 'X-Switch-Connection-Id': connectionId } : {},
  });
}

/**
 * Post to a room without needing a connection at all — the plain message
 * route rather than the post_message operation. This is what the outbound
 * driver uses, so a send never depends on the stream being up at that instant.
 */
async function postMessage(roomId, content) {
  // ensureConfig() BEFORE building the path, not just inside api(): the
  // template literal is evaluated first, so reading state.agentId here would
  // bake in a null from a process that has never connected. Switch happens to
  // resolve the agent from the API key and ignore the path segment, so
  // "/agents/null/message" still delivers today — which is exactly what makes
  // this the kind of bug that surfaces much later, on a server that doesn't.
  const { agentId } = ensureConfig();
  return api(`/agents/${agentId}/message`, {
    method: 'POST',
    body: { room_id: roomId, content },
  });
}

/**
 * Upload a file into a room as the agent (multipart), optionally with a
 * caption. Switch stores the bytes and posts an m.image / m.file event, which
 * each platform bridge then renders in its own idiom.
 *
 * Needs no connection — like postMessage, so a worker process can call it
 * through the relay without ever opening a stream of its own.
 */
async function uploadMedia(roomId, buffer, filename, mimeType, caption) {
  ensureConfig();
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), filename || 'attachment');
  if (caption) form.append('caption', caption);

  const res = await fetch(`${state.bridgeUrl}/agents/${state.agentId}/rooms/${roomId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${state.apiKey}` }, // no Content-Type: fetch sets the multipart boundary
    body: form,
  });
  const text = await res.text();
  if (!res.ok) {
    const error = new Error(`Switch media upload -> ${res.status}: ${String(text).slice(0, 300)}`);
    error.status = res.status;
    throw error;
  }
  try { return JSON.parse(text); } catch { return { ok: true }; }
}

/**
 * Fetch an inbound attachment's bytes.
 *
 * An attachment on a message event is a POINTER, never bytes — it carries
 * `mxc`, `filename`, `mimetype` and `size`, and this is the only way to get
 * the content behind it.
 */
async function downloadMedia(roomId, mxc) {
  ensureConfig();
  const res = await fetch(
    `${state.bridgeUrl}/agents/${state.agentId}/rooms/${roomId}/media?mxc=${encodeURIComponent(mxc)}`,
    { headers: { Authorization: `Bearer ${state.apiKey}` } }
  );
  if (!res.ok) {
    const error = new Error(`Switch media download -> ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    mimeType: res.headers.get('content-type') || 'application/octet-stream',
  };
}

/**
 * Splits an SSE byte stream into frames.
 *
 * A line beginning with ":" is a KEEPALIVE comment, not a frame — the server
 * writes one every 15s when nothing has happened, purely so an intermediate
 * proxy does not drop an idle stream. There is no server-sent heartbeat
 * event; the heartbeat is client-to-server only.
 */
async function* parseSse(body, signal) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += value;

      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const frame = { id: null, event: 'message', data: '' };
        for (const line of raw.split('\n')) {
          if (!line || line.startsWith(':')) continue; // keepalive / comment
          const sep = line.indexOf(':');
          const field = sep === -1 ? line : line.slice(0, sep);
          const val = sep === -1 ? '' : line.slice(sep + 1).replace(/^ /, '');
          if (field === 'id') frame.id = val;
          else if (field === 'event') frame.event = val;
          else if (field === 'data') frame.data += val;
        }
        if (frame.data) yield frame;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * The heartbeat. 404 (connection unknown or dead) and 409 (no stream attached)
 * BOTH mean reopen the stream — not back off. Retrying the beat on either
 * keeps a dead connection dead, and you cannot hold a connection open by
 * beating alone: a beat is refused when no stream is attached.
 */
async function beat() {
  try {
    const res = await api(`/agents/${state.agentId}/connection/beat`, {
      method: 'POST',
      body: {
        connection_id: connectionId,
        cursor: typeof state.cursor === 'number' ? state.cursor : 0,
      },
    });
    if (res && typeof res.cursor === 'number') state.cursor = res.cursor;
    if (res && Array.isArray(res.rooms)) state.rooms = res.rooms;
  } catch (error) {
    if (error.status === 404 || error.status === 409) {
      logToFile(`Switch heartbeat ${error.status} — reopening stream`, { level: 'warn' });
      stopBeating();
      scheduleReconnect(250);
      return;
    }
    logToFile(`Switch heartbeat error: ${error.message}`, { level: 'warn' });
  }
}

function startBeating(seconds) {
  stopBeating();
  beatTimer = setInterval(beat, (seconds || DEFAULT_BEAT_SECONDS) * 1000);
  if (typeof beatTimer.unref === 'function') beatTimer.unref();
}

function stopBeating() {
  if (beatTimer) clearInterval(beatTimer);
  beatTimer = null;
}

function scheduleReconnect(delayMs) {
  if (shuttingDown) return;
  state.connected = false;
  const timer = setTimeout(() => {
    openStream().catch((error) => {
      logToFile(`Switch reconnect failed: ${error.message}`, { level: 'error' });
      scheduleReconnect(Math.min(delayMs * 2, 30000));
    });
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
}

/**
 * Opens (or reopens) the event stream.
 *
 * scope=all so the agent covers every room it belongs to without claiming any
 * — Rumi answers teachers wherever it has been invited, rather than attending
 * one room at a time.
 *
 * filter=all, NOT addressed: a connection filtered to `addressed` never
 * receives `command` events at all, and Rumi's slash commands (/language,
 * /video, attendance) arrive as exactly those. Delivery and acting are
 * different things — the adapter decides what to act on.
 */
async function openStream() {
  const url = new URL(`${state.bridgeUrl}/agents/${state.agentId}/events`);
  url.searchParams.set('connection_id', connectionId);
  url.searchParams.set('scope', 'all');
  url.searchParams.set('filter', 'all');
  url.searchParams.set('start_from', typeof state.cursor === 'number' ? String(state.cursor) : 'head');
  url.searchParams.set('client', 'rumi-platform');
  url.searchParams.set('client_version', CLIENT_VERSION);

  abortController = new AbortController();

  const headers = {
    Authorization: `Bearer ${state.apiKey}`,
    Accept: 'text/event-stream',
  };
  // Last-Event-ID beats start_from when both are present — it is the more
  // precise resume point, so send it whenever we have one.
  if (typeof state.cursor === 'number') headers['Last-Event-ID'] = String(state.cursor);

  const res = await fetch(url, { headers, signal: abortController.signal });
  if (!res.ok || !res.body) {
    const detail = res.body ? String(await res.text()).slice(0, 300) : '(no body)';
    throw new Error(`Switch stream open -> ${res.status}: ${detail}`);
  }

  state.connected = true;
  consume(res.body, abortController.signal).catch((error) => {
    if (shuttingDown || error.name === 'AbortError') return;
    logToFile(`Switch stream error: ${error.message}`, { level: 'warn' });
    stopBeating();
    scheduleReconnect(1000);
  });
}

async function consume(body, signal) {
  for await (const frame of parseSse(body, signal)) {
    let payload;
    try {
      payload = JSON.parse(frame.data);
    } catch {
      continue; // a frame we cannot parse is not worth stalling the stream for
    }

    switch (frame.event) {
      // Always the first frame. Read it rather than assuming — the heartbeat
      // interval and the rooms list are the server's answer, not an echo.
      case 'connection_state':
        state.cursor = payload.cursor ?? state.cursor;
        state.rooms = Array.isArray(payload.rooms) ? payload.rooms : [];
        logToFile('✅ Switch connected', {
          rooms: state.rooms.length,
          cursor: payload.cursor,
          protocol: payload.protocol,
        });
        startBeating(payload.heartbeat_interval_seconds);
        events.emit('open', { rooms: state.rooms, protocol: payload.protocol });
        continue;

      // Another stream attached to this connection id, or the heartbeat
      // lapsed. Reconnecting immediately would fight whoever took it, so this
      // is loud and does NOT auto-reopen.
      case 'evicted':
        logToFile(`⚠️ Switch connection evicted: ${payload.reason}`, { level: 'error' });
        state.connected = false;
        stopBeating();
        events.emit('evicted', payload);
        return;

      // Not a wake. Hold it and attach it to the next event surfaced, and
      // re-read room history before responding — the buffer is in memory, so
      // a server restart resets the sequence.
      case 'gap':
        logToFile(`Switch gap from sequence ${payload.from_sequence}: ${payload.reason}`, { level: 'warn' });
        events.emit('gap', payload);
        continue;

      case 'subscription_changed':
        state.rooms = Array.isArray(payload.rooms) ? payload.rooms : state.rooms;
        events.emit('rooms', state.rooms);
        continue;

      case 'room_released':
        events.emit('room_released', payload);
        continue;

      default:
        break;
    }

    // A domain event. The SSE id line and payload.sequence are the same
    // number; cursors only move forward, so take the max.
    if (frame.id) {
      const seq = Number(frame.id);
      if (Number.isFinite(seq)) state.cursor = Math.max(seq, typeof state.cursor === 'number' ? state.cursor : 0);
    }
    events.emit('event', { type: frame.event, ...payload });
  }
}

/**
 * Connects, idempotently. Safe to call more than once in a process; the
 * second call returns the first call's promise rather than opening a second
 * stream (which would evict the first).
 */
async function connect(env = process.env) {
  if (connectPromise) return connectPromise;

  const cfg = ensureConfig(env);

  shuttingDown = false;
  if (!connectionId) connectionId = randomUUID();
  state = { ...state, ...cfg, connected: false, cursor: 'head', rooms: [] };

  connectPromise = openStream().catch((error) => {
    connectPromise = null;
    throw error;
  });
  return connectPromise;
}

async function close() {
  shuttingDown = true;
  stopBeating();
  if (abortController) abortController.abort();
  abortController = null;
  connectPromise = null;
  state.connected = false;
  logToFile('Switch connection closed');
}

/** Test-only: resets every piece of module state, including the connection id. */
function _resetForTests() {
  stopBeating();
  if (abortController) abortController.abort();
  abortController = null;
  connectPromise = null;
  connectionId = null;
  shuttingDown = false;
  state = { connected: false, agentId: null, apiKey: null, bridgeUrl: null, cursor: 'head', rooms: [] };
  events.removeAllListeners();
}

module.exports = {
  events,
  connect,
  close,
  isConnected,
  getAgentId,
  getRooms,
  callOp,
  postMessage,
  uploadMedia,
  downloadMedia,
  api,
  config,
  ensureConfig,
  _resetForTests,
  // Exposed for the relay and for tests that need to assert takeover safety.
  _connectionId: () => connectionId,
};
