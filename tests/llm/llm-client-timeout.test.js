/**
 * An LLM call that stalls must fail fast enough for Rumi to tell the teacher.
 *
 * Reported from the staffroom, twice in one day, in two different features:
 *
 *   "I asked you for a lesson plan twice today and both times it just stopped.
 *    You said you were preparing it and then nothing ever came through."
 *
 *   "the reading assessment has been stuck for ten minutes now, it just says
 *    processing and nothing ever comes back."
 *
 * Both features ACK first and work second — text-message.handler.js sends
 * "I'm preparing a detailed five-step lesson plan for you" before it extracts
 * the topic, and reading-assessment.service.js sends "we're analysing, this
 * will take 3-5 minutes" before it runs the pipeline. Every step after that
 * ack goes through bot/shared/services/llm-client.js, the one chokepoint 34
 * files share.
 *
 * That client was constructed with no `timeout` and no `maxRetries`, so it
 * inherited the OpenAI SDK's defaults: a 10-minute timeout, retried twice.
 * A provider that accepts the connection and then says nothing therefore
 * stalls for up to THIRTY MINUTES before the code that apologises to the
 * teacher is ever reached. "Stuck for ten minutes" is not a coincidence —
 * it is one timeout window, observed from the staffroom.
 *
 * The failure modes these tests pin are not hypothetical for a
 * bring-your-own-keys project: a free-tier endpoint under load, a local
 * Ollama mid-reload, and a proxy that holds the socket open all look exactly
 * like the server below.
 *
 * The contract: a stalled call rejects on a bounded, configurable deadline,
 * and the default deadline is short enough that a teacher is told something
 * went wrong while she is still waiting.
 */

const http = require('http');

const BOT = '../../bot/shared/services/llm-client';

/** A server that accepts the request and then never answers it. */
function startStallingServer() {
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = http.createServer(() => { /* deliberately no response, ever */ });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => {
          for (const s of sockets) s.destroy();
          server.close(done);
        }),
      });
    });
  });
}

function loadClient(env) {
  jest.resetModules();
  Object.assign(process.env, env);
  // eslint-disable-next-line global-require
  return require(BOT);
}

describe('llm-client: a stalled provider must not hold a teacher for half an hour', () => {
  const originalEnv = { ...process.env };
  let stalling;

  beforeAll(async () => { stalling = await startStallingServer(); });
  afterAll(async () => { await stalling.close(); });
  afterEach(() => { process.env = { ...originalEnv }; jest.resetModules(); });

  it('rejects a stalled completion on the configured deadline instead of hanging', async () => {
    const { getClient } = loadClient({
      LLM_BASE_URL: stalling.url,
      LLM_API_KEY: 'k',
      LLM_TIMEOUT_MS: '400',
      LLM_MAX_RETRIES: '0',
    });

    const startedAt = Date.now();
    await expect(
      getClient().chat.completions.create({
        model: 'any-model',
        messages: [{ role: 'user', content: 'extract the topic' }],
      })
    ).rejects.toThrow();

    // Generous headroom over the 400ms deadline; the bug is 600000ms.
    expect(Date.now() - startedAt).toBeLessThan(10000);
  });

  it('bounds the retries too — a deadline retried forever is not a deadline', async () => {
    let requests = 0;
    const { getClient } = loadClient({
      LLM_BASE_URL: stalling.url,
      LLM_API_KEY: 'k',
      LLM_TIMEOUT_MS: '300',
      LLM_MAX_RETRIES: '1',
    });

    const startedAt = Date.now();
    await expect(
      getClient().chat.completions.create({
        model: 'any-model',
        messages: [{ role: 'user', content: 'hello' }],
      })
    ).rejects.toThrow();

    // 1 retry => at most 2 attempts of 300ms, plus the SDK's backoff.
    expect(Date.now() - startedAt).toBeLessThan(10000);
    expect(requests).toBe(0); // nothing was ever answered; the deadline did the work
  });

  it('defaults are short enough to apologise to a teacher who is still waiting', () => {
    const { getClient } = loadClient({
      LLM_BASE_URL: stalling.url,
      LLM_API_KEY: 'k',
      LLM_TIMEOUT_MS: '',
      LLM_MAX_RETRIES: '',
    });
    const client = getClient();

    // The SDK ships 600000ms x 3 attempts. A teacher told "3-5 minutes" must
    // not be able to wait thirty before anything is said to her.
    expect(client.timeout).toBeLessThanOrEqual(120000);
    expect(client.maxRetries).toBeLessThanOrEqual(1);
    expect(client.timeout * (client.maxRetries + 1)).toBeLessThanOrEqual(240000);
  });
});
