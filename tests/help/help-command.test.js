/**
 * /help — the capability listing a teacher can ask for by name.
 *
 * Built from a live miss, in the teacher's own words:
 *
 *   "It would really help if i could type /help and see what you can do"
 *
 * Three things are worth locking down, and each has a failure mode that has
 * already happened once in this repo:
 *
 *  1. The trigger is ANCHORED. The sentence above itself contains "/help",
 *     and it is a feature request that must keep reaching the escalation
 *     path (escalation-trigger.js was written for that exact sentence). A
 *     loose match would answer it with help text and silently kill the
 *     escalation — turning a working feature into a dead one.
 *  2. The listing is RENDERED from capabilities.config.js, not retyped. The
 *     repo already carries four separate hand-written "what I can do" blurbs
 *     that have drifted apart; a fifth copy would be the bug, not the feature.
 *  3. The command is DISPATCHED. A trigger module nothing calls is the
 *     orphan-dispatch class this repo's route-contract tests exist to catch,
 *     so the handler source is asserted directly (see the qa-testing skill).
 *
 * help-trigger.js is pure — it pulls two plain config object literals and
 * nothing else — so no bot-only dependency needs mocking here.
 */

const fs = require('fs');
const path = require('path');

const {
  HELP_TRIGGER_RX,
  evaluateHelpTrigger,
  buildHelpMessage,
} = require('../../bot/shared/handlers/help-trigger');
const { capabilities } = require('../../bot/shared/config/capabilities.config');

describe('evaluateHelpTrigger', () => {
  it('matches /help however the teacher capitalises or spaces it', () => {
    for (const m of ['/help', '/HELP', '/Help', '  /help  ', '/help\n']) {
      expect(evaluateHelpTrigger({ messageBody: m }).match).toBe(true);
    }
  });

  it('does NOT match the feature-request sentence that prompted this command', () => {
    // The whole reason the regex is anchored. This sentence must keep falling
    // through to escalation-trigger.js, which was built to catch it verbatim.
    const asked = 'it would really help If i typed /help and see what you can do.';
    expect(evaluateHelpTrigger({ messageBody: asked }).match).toBe(false);
  });

  it('does NOT match other commands or /help with arguments', () => {
    for (const m of ['/helper', '/help me with a lesson plan', 'help', '/menu', 'can you help']) {
      expect(evaluateHelpTrigger({ messageBody: m }).match).toBe(false);
    }
  });

  it('is side-effect-free on empty and missing input', () => {
    expect(evaluateHelpTrigger({ messageBody: '' }).match).toBe(false);
    expect(evaluateHelpTrigger({}).match).toBe(false);
    expect(evaluateHelpTrigger().match).toBe(false);
  });

  it('exports an anchored pattern', () => {
    expect(HELP_TRIGGER_RX.source.startsWith('^')).toBe(true);
    expect(HELP_TRIGGER_RX.source.endsWith('$')).toBe(true);
  });
});

describe('buildHelpMessage', () => {
  it('lists every capability in the config — so it cannot go stale', () => {
    const message = buildHelpMessage('en');
    expect(capabilities.length).toBeGreaterThan(0);
    for (const cap of capabilities) {
      expect(message).toContain(cap.name.en);
      expect(message).toContain(cap.description.en);
      expect(message).toContain(cap.howToUse.en);
    }
  });

  it('tells the teacher how to start a reading assessment', () => {
    // The one capability whose howToUse names a command: the listing is
    // useless if it describes features without saying how to reach them.
    expect(buildHelpMessage('en')).toContain('/reading test');
  });

  it('renders in the teacher\'s own language', () => {
    const urdu = buildHelpMessage('ur');
    for (const cap of capabilities) expect(urdu).toContain(cap.name.ur);
  });

  it('falls back to English for a supported language the config lacks', () => {
    // supported-languages.js carries 16 codes; capabilities.config.js carries
    // four. A Punjabi teacher must get English, never an empty listing.
    const punjabi = buildHelpMessage('pa-PK');
    for (const cap of capabilities) expect(punjabi).toContain(cap.name.en);
    expect(punjabi).not.toMatch(/undefined/);
  });

  it('defaults to English when called with no language at all', () => {
    expect(buildHelpMessage()).toContain(capabilities[0].name.en);
    expect(buildHelpMessage()).not.toMatch(/undefined/);
  });

  it('points at /menu for the browsable version rather than duplicating it', () => {
    expect(buildHelpMessage('en')).toContain('/menu');
  });
});

describe('dispatch (route contract)', () => {
  const handlerSrc = fs.readFileSync(
    path.join(__dirname, '../../bot/shared/handlers/text-message.handler.js'),
    'utf8'
  );

  it('text-message.handler.js actually dispatches the trigger', () => {
    expect(handlerSrc).toMatch(/evaluateHelpTrigger\(\{\s*messageBody\s*\}\)\.match/);
    expect(handlerSrc).toMatch(/buildHelpMessage\(responseLanguage\)/);
  });

  it('answers /help before any other command branch could swallow it', () => {
    // A teacher mid-quiz who types /help is the case that matters: the help
    // branch must come before the rest of the waterfall, not after it.
    const helpAt = handlerSrc.indexOf('evaluateHelpTrigger');
    const portalAt = handlerSrc.indexOf("trimmedMessage === '/portal'");
    expect(helpAt).toBeGreaterThan(-1);
    expect(portalAt).toBeGreaterThan(-1);
    expect(helpAt).toBeLessThan(portalAt);
  });
});

describe('command registry', () => {
  const {
    SLACK_SLASH_COMMANDS,
    SLACK_RESERVED_COMMANDS,
  } = require('../../bot/scripts/setup/fields');

  it('registers /help so Discord can offer it in autocomplete', () => {
    expect(SLACK_SLASH_COMMANDS).toContain('/help');
  });

  it('skips /help on Slack, which reserves the name', () => {
    expect(SLACK_RESERVED_COMMANDS).toContain('/help');
  });
});
