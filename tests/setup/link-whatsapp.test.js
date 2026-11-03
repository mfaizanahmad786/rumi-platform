/**
 * link-whatsapp.js — pairing the sandbox channel by QR.
 *
 * The case under test is the one that has no happy path: a QR code you cannot
 * scan. Pairing blocks for two and a half minutes by design (a human has to
 * pick up a phone and find Linked Devices), and for as long as `rumi setup`
 * offered no way out of that wait, Ctrl+C was the only key that did anything —
 * which ends the wizard rather than the step.
 *
 * `opts.cancel` is the way out. These tests pin it to the contract the wizard
 * relies on: resolving it settles pairing promptly, with a reason the caller
 * can distinguish from a genuine failure.
 */

const { EventEmitter } = require('events');

const { linkWhatsApp } = require('../../bot/scripts/setup/link-whatsapp');

/**
 * A connection that opens a socket and then does nothing — the state a user
 * is in while a QR code sits on screen unscanned.
 */
function stalledConnection() {
  return {
    events: new EventEmitter(),
    authDir: () => '/nonexistent',
    getSocket: () => new Promise(() => {}),
    close: async () => {},
  };
}

describe('giving up on a QR code', () => {
  it('settles as soon as cancel resolves, rather than waiting out the timeout', async () => {
    const connection = stalledConnection();
    let giveUp;
    const cancel = new Promise((resolve) => { giveUp = resolve; });

    // A timeout far longer than this test could tolerate: if cancel were not
    // honoured, this would hang rather than fail, so the assertion below is
    // only reachable via the cancel path.
    const pending = linkWhatsApp({ connection, cancel, timeoutMs: 10 * 60 * 1000 });
    giveUp();

    await expect(pending).resolves.toEqual({ ok: false, reason: 'skipped' });
  });

  it('calls it "skipped", not a failure — the wizard apologises for one and not the other', async () => {
    const connection = stalledConnection();
    const result = await linkWhatsApp({ connection, cancel: Promise.resolve(), timeoutMs: 10 * 60 * 1000 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('skipped');
    // 'timeout', 'logged-out' and 'busy' all print an explanation and an
    // invitation to try again. Choosing to skip should print neither.
    expect(['timeout', 'logged-out', 'busy', 'error']).not.toContain(result.reason);
  });

  it('leaves no listeners behind on the shared connection', async () => {
    const connection = stalledConnection();
    await linkWhatsApp({ connection, cancel: Promise.resolve(), timeoutMs: 10 * 60 * 1000 });

    // The events emitter outlives this call — the bot uses the same one — so a
    // skipped pairing that kept its listeners would have them fire against a
    // later, unrelated connection.
    expect(connection.events.listenerCount('open')).toBe(0);
    expect(connection.events.listenerCount('close')).toBe(0);
  });

  it('a successful pairing is unaffected by a cancel that never resolves', async () => {
    const connection = stalledConnection();
    const pending = linkWhatsApp({
      connection,
      cancel: new Promise(() => {}),
      timeoutMs: 10 * 60 * 1000,
    });
    connection.events.emit('open');

    await expect(pending).resolves.toEqual({ ok: true, number: null });
  });

  it('a rejected cancel does not become a pairing error', async () => {
    const connection = stalledConnection();
    // Ctrl+C rejects the keypress promise. That is the wizard's business to
    // handle — it stops setup altogether — and must not be swallowed here as
    // a pairing failure, nor crash the process as an unhandled rejection.
    const pending = linkWhatsApp({
      connection,
      cancel: Promise.reject(new Error('aborted')),
      timeoutMs: 10 * 60 * 1000,
    });
    connection.events.emit('open');

    await expect(pending).resolves.toEqual({ ok: true, number: null });
  });
});
