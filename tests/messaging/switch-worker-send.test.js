/**
 * A worker process must be able to deliver over Switch, and must never open
 * an event stream doing it.
 *
 * Both halves matter, and the second is the one with teeth. Lesson plans,
 * coaching reports, reading results, videos and exam grading are all sent
 * FROM THE WORKER, minutes after the teacher asked, through the same
 * WhatsAppService facade the bot uses. The worker has the same env but has
 * never called connect().
 *
 *   - If a worker send needed a connection, nothing the worker produces would
 *     ever arrive. That is precisely what upstream PR #104 hit on Matrix,
 *     where it forced a whole Redis relay (matrix-outbound-relay.js) to carry
 *     worker sends back to the bot process.
 *   - If a worker send OPENED a connection, it would be worse than useless:
 *     reopening this agent's connection id is a takeover, and the bot's
 *     stream would be terminated with an `evicted` frame — every teacher's
 *     messages would stop arriving, on every channel the bot serves.
 *
 * Switch needs no relay because its send routes are stateless HTTP:
 * POST /agents/{id}/message and the media routes authenticate with the API
 * key alone and take the room as an argument. These tests pin that, so a
 * future change that makes a send depend on connection state fails here
 * rather than in production at 2am.
 */

const ROOM = '2202d944-5596-4f01-b8b6-0915f8509a9e';
const PERSON = '@switch-mattermost-8cb57433-523e-4fcf-a285-1bef838e7641-user:localhost';
const TO = `switch:${ROOM}|${PERSON}`;

const ENV = {
  SWITCH_BRIDGE_URL: 'http://switch.test:8000',
  SWITCH_AGENT_ID: 'agent-abc',
  SWITCH_AGENT_API_KEY: 'key-xyz',
};

function loadWithFetch(fetchImpl, env = ENV) {
  jest.resetModules();
  jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
  jest.doMock('../../bot/shared/storage/r2', () => ({
    downloadFromR2: jest.fn(),
    extractKeyFromUrl: jest.fn(),
  }));
  global.fetch = fetchImpl;
  Object.assign(process.env, env);
  return {
    driver: require('../../bot/shared/services/messaging/switch-channel.service'),
    connection: require('../../bot/shared/services/messaging/switch-connection'),
  };
}

function okJson(body = { ok: true, event_id: 'evt-1' }) {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
    headers: { get: () => 'application/json', getSetCookie: () => [] },
  });
}

describe('Switch: a worker sends without a connection', () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  it('sendMessage works in a process that never called connect()', async () => {
    const calls = [];
    const { driver, connection } = loadWithFetch((url, opts) => {
      calls.push({ url: String(url), method: opts?.method });
      return okJson();
    });

    expect(connection.isConnected()).toBe(false); // never connected, and stays that way

    await expect(driver.sendMessage(TO, 'your lesson plan is ready')).resolves.toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('http://switch.test:8000/agents/agent-abc/message');
    expect(connection.isConnected()).toBe(false);
  });

  it('never opens the event stream — a worker that did would evict the bot', async () => {
    const calls = [];
    const { driver } = loadWithFetch((url, opts) => {
      calls.push(String(url));
      return okJson();
    });

    await driver.sendMessage(TO, 'one');
    await driver.sendDocument(TO, Buffer.from('%PDF-1.4'), 'plan.pdf', 'your plan');

    // /events is the ONLY route that creates a connection. Nothing a worker
    // does may touch it.
    expect(calls.some((u) => u.includes('/events'))).toBe(false);
    expect(calls.some((u) => u.includes('connection/beat'))).toBe(false);
  });

  it('sends the room from the identifier, not from any connection state', async () => {
    let body = null;
    const { driver } = loadWithFetch((url, opts) => {
      body = JSON.parse(opts.body);
      return okJson();
    });

    await driver.sendMessage(TO, 'hello');

    // The room travels inside `to`; that is the whole reason the identifier
    // carries a pair.
    expect(body.room_id).toBe(ROOM);
    expect(body.content).toBe('hello');
  });

  it('uploads media to the room route, still with no connection', async () => {
    const calls = [];
    const { driver } = loadWithFetch((url, opts) => {
      calls.push({ url: String(url), method: opts?.method });
      return okJson({ ok: true });
    });

    await expect(
      driver.sendDocument(TO, Buffer.from('%PDF-1.4'), 'lesson-plan.pdf', 'your plan')
    ).resolves.toBe(true);

    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(`http://switch.test:8000/agents/agent-abc/rooms/${ROOM}/media`);
  });

  it('a missing credential is a named error, not a request to undefined', async () => {
    const calls = [];
    const { connection } = loadWithFetch(
      (url) => { calls.push(String(url)); return okJson(); },
      { SWITCH_BRIDGE_URL: '', SWITCH_AGENT_ID: '', SWITCH_AGENT_API_KEY: '' }
    );

    expect(() => connection.ensureConfig({})).toThrow(/SWITCH_BRIDGE_URL/);
    // Nothing was dialled — no "http://undefined/agents/null/message".
    expect(calls).toHaveLength(0);
  });
});
