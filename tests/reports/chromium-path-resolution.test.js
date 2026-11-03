/**
 * Finding a browser to render with, on the OS the developer is actually using.
 *
 * playwright-core deliberately bundles no browser, so html-to-pdf.js hunts for
 * a system install. The candidate list was Linux-only — correct for
 * production, wrong for the README's promise that anyone can clone this and
 * run it in fifteen minutes, which a lot of people do on a Mac.
 *
 * The failure was quiet, which is why it lasted. Every candidate missed,
 * Playwright threw, and the caller fell back to PDFKit (see
 * reading/report.service.js:120). Reports still came out. What was lost was
 * Urdu: Chromium's HarfBuzz pipeline shapes Nastaliq and joins letters,
 * PDFKit with Helvetica cannot — so a Mac developer silently got the one
 * rendering path this product most needs to be right, degraded, with nothing
 * saying so.
 *
 * These tests use a fake filesystem rather than the real one, so they assert
 * the LOOKUP RULES and pass on any machine, including CI, which has neither
 * Chrome nor /Applications.
 */

const path = require('path');

const MODULE = '../../bot/shared/utils/html-to-pdf';

/** Loads the module with a filesystem where exactly `present` paths exist. */
function loadWith(present, env = {}) {
  jest.resetModules();
  jest.doMock('fs', () => ({
    ...jest.requireActual('fs'),
    existsSync: (p) => present.includes(String(p)),
  }));
  // Virtual: playwright-core lives in bot/node_modules, and CI runs the root
  // suite before `bot/ npm ci` — see CLAUDE.md on mocking bot-only deps.
  jest.doMock('playwright-core', () => ({ chromium: { launch: jest.fn() } }), { virtual: true });
  jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));

  const saved = { ...process.env };
  // Clear the explicit overrides unless the test sets them, or the developer's
  // own environment leaks into the assertion.
  delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  delete process.env.PUPPETEER_EXECUTABLE_PATH;
  Object.assign(process.env, env);

  // eslint-disable-next-line global-require
  const mod = require(MODULE);
  return { resolve: mod.resolveChromiumPath, restore: () => { process.env = saved; } };
}

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MAC_CHROMIUM = '/Applications/Chromium.app/Contents/MacOS/Chromium';
const LINUX_CHROMIUM = '/usr/bin/chromium';

describe('resolveChromiumPath', () => {
  afterEach(() => jest.resetModules());

  it('finds Chrome where macOS actually puts it', () => {
    // The whole bug: this returned null before, on every Mac.
    const { resolve, restore } = loadWith([MAC_CHROME]);
    expect(resolve()).toBe(MAC_CHROME);
    restore();
  });

  it('finds Chromium on macOS too', () => {
    const { resolve, restore } = loadWith([MAC_CHROMIUM]);
    expect(resolve()).toBe(MAC_CHROMIUM);
    restore();
  });

  it('finds a per-user install under ~/Applications', () => {
    const home = process.env.HOME || '/Users/someone';
    const userChrome = path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    const { resolve, restore } = loadWith([userChrome]);
    expect(resolve()).toBe(userChrome);
    restore();
  });

  it('still prefers Linux paths, which is what production runs on', () => {
    // Both present: Linux must win, so a container that happens to mount a
    // macOS-shaped path does not get a surprise.
    const { resolve, restore } = loadWith([LINUX_CHROMIUM, MAC_CHROME]);
    expect(resolve()).toBe(LINUX_CHROMIUM);
    restore();
  });

  it('prefers Chrome over Chromium on macOS, because far more people have it', () => {
    const { resolve, restore } = loadWith([MAC_CHROMIUM, MAC_CHROME]);
    expect(resolve()).toBe(MAC_CHROME);
    restore();
  });

  it('lets an explicit env var beat every discovered path', () => {
    const custom = '/opt/my-own/chromium';
    const { resolve, restore } = loadWith([custom, LINUX_CHROMIUM, MAC_CHROME], {
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: custom,
    });
    expect(resolve()).toBe(custom);
    restore();
  });

  it('accepts the PUPPETEER_ name too, for hosts that set it', () => {
    const custom = '/opt/legacy/chrome';
    const { resolve, restore } = loadWith([custom], { PUPPETEER_EXECUTABLE_PATH: custom });
    expect(resolve()).toBe(custom);
    restore();
  });

  it('returns null when there is genuinely no browser, so the caller can fall back', () => {
    // Null is a real answer here, not a failure: reading/report.service.js
    // catches the resulting throw and renders with PDFKit instead.
    const { resolve, restore } = loadWith([]);
    expect(resolve()).toBeNull();
    restore();
  });

  it('ignores an env var pointing at something that is not there', () => {
    const { resolve, restore } = loadWith([MAC_CHROME], {
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/nope/not/here',
    });
    expect(resolve()).toBe(MAC_CHROME);
    restore();
  });
});
