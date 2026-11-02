/**
 * channel-registry — pure data, no env/process logic. Confirms the shape the
 * rest of the messaging module (and feature-availability.js) builds on: a
 * default-sandbox rule with an explicit production allowlist, not a per-driver
 * tag someone has to remember to set. Also confirms the additive-channel
 * concept (Slack, Discord, ...) — drivers that run ALONGSIDE the one
 * WhatsApp-family driver (meta|baileys) via their own env-var presence,
 * never selected through CHANNEL_DRIVER, each carrying a wire prefix so
 * messaging/index.js's router can dispatch to them by identifier shape.
 */

const registry = require('../../bot/shared/services/messaging/channel-registry');

describe('channel-registry', () => {
  it('lists meta and baileys as the WhatsApp-family drivers, defaulting to baileys', () => {
    expect(Object.keys(registry.DRIVERS)).toEqual(expect.arrayContaining(['baileys', 'meta']));
    expect(registry.DEFAULT_DRIVER).toBe('baileys');
  });

  it('lists slack, discord and switch as additive channel drivers, alongside the WhatsApp-family ones', () => {
    expect(registry.DRIVERS.slack).toBe('./slack-channel.service');
    expect(registry.DRIVERS.discord).toBe('./discord-channel.service');
    expect(registry.DRIVERS.switch).toBe('./switch-channel.service');
  });

  it('meta, slack, discord and switch are the production-tier drivers — baileys is sandbox only', () => {
    expect(registry.PRODUCTION_TIER_DRIVERS.sort()).toEqual(['discord', 'meta', 'slack', 'switch']);
    expect(registry.isProductionTier('meta')).toBe(true);
    expect(registry.isProductionTier('slack')).toBe(true);
    expect(registry.isProductionTier('discord')).toBe(true);
    expect(registry.isProductionTier('switch')).toBe(true);
    expect(registry.isProductionTier('baileys')).toBe(false);
    // A hypothetical future driver not yet on the allowlist is sandbox by default.
    expect(registry.isProductionTier('telegram')).toBe(false);
  });

  it('isKnownDriver reflects exactly the DRIVERS map', () => {
    expect(registry.isKnownDriver('meta')).toBe(true);
    expect(registry.isKnownDriver('baileys')).toBe(true);
    expect(registry.isKnownDriver('slack')).toBe(true);
    expect(registry.isKnownDriver('discord')).toBe(true);
    expect(registry.isKnownDriver('telegram')).toBe(false);
  });

  it('slack/discord carry their own wire prefix; WhatsApp-family drivers carry none', () => {
    expect(registry.prefixFor('slack')).toBe('slack');
    expect(registry.prefixFor('discord')).toBe('discord');
    expect(registry.prefixFor('meta')).toBeNull();
    expect(registry.prefixFor('baileys')).toBeNull();
  });

  it('driverForIdentifier resolves a prefixed identifier to its driver, and a bare phone number to null', () => {
    expect(registry.driverForIdentifier('slack:U0123ABC')).toBe('slack');
    expect(registry.driverForIdentifier('discord:918273645')).toBe('discord');
    expect(registry.driverForIdentifier('923001234567')).toBeNull();
  });
});

/**
 * Switch identifiers are the one channel whose identifier names two things —
 * the room a reply goes to, and the person it is about. These lock the shape,
 * because getting it wrong is not a code fix: the identifier is persisted and
 * is all a background worker has when it delivers a lesson plan minutes later.
 */
describe('channel-registry — switch identifiers', () => {
  const registry = require('../../bot/shared/services/messaging/channel-registry');

  // Real ids, taken from a running Switch server rather than invented: the
  // room is a plain UUID and the participant carries both an "@" and a colon.
  const ROOM = '2202d944-5596-4f01-b8b6-0915f8509a9e';
  const PARTICIPANT = '@switch-mattermost-8cb57433-523e-4fcf-a285-1bef838e7641-user:localhost';

  it('round-trips a room and a participant through one identifier', () => {
    const id = registry.buildSwitchIdentifier(ROOM, PARTICIPANT);
    expect(registry.parseSwitchIdentifier(id)).toEqual({ roomId: ROOM, participantId: PARTICIPANT });
  });

  it('routes to the switch driver despite the colons inside the participant id', () => {
    // driverForIdentifier splits on the FIRST colon only, which is what makes
    // a colon-bearing payload safe to carry.
    const id = registry.buildSwitchIdentifier(ROOM, PARTICIPANT);
    expect(registry.driverForIdentifier(id)).toBe('switch');
  });

  it('separates on a pipe, never a colon', () => {
    expect(registry.SWITCH_ID_SEPARATOR).toBe('|');
    const id = registry.buildSwitchIdentifier(ROOM, PARTICIPANT);
    // A colon separator would truncate the participant at "localhost".
    expect(id.split('|')[1]).toBe(PARTICIPANT);
  });

  it('refuses a malformed identifier rather than guessing', () => {
    expect(registry.parseSwitchIdentifier('switch:no-separator-here')).toBeNull();
    expect(registry.parseSwitchIdentifier(`switch:|${PARTICIPANT}`)).toBeNull(); // no room
    expect(registry.parseSwitchIdentifier(`switch:${ROOM}|`)).toBeNull();        // no person
    expect(registry.parseSwitchIdentifier('slack:U0123ABC')).toBeNull();
    expect(registry.parseSwitchIdentifier('923001234567')).toBeNull();
  });
});
