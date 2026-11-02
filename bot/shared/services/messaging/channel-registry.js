/**
 * channel-registry — static map of known messaging channel drivers.
 *
 * Adding a channel (e.g. Slack) is a two-line change: a DRIVERS entry pointing
 * at its service module, and — only if it requires a formal business
 * registration process the way Meta does — an addition to
 * PRODUCTION_TIER_DRIVERS. Every driver not listed there is sandbox-tier by
 * default; no per-driver tagging to remember.
 *
 * This file holds data only, no env/process logic, so it has zero
 * dependencies and can be required from anywhere (feature-availability.js,
 * messaging/index.js, doctor.js) without risk of a require cycle.
 */

const DRIVERS = {
  meta: './meta-channel.service',
  baileys: './baileys-channel.service',
  slack: './slack-channel.service',
  discord: './discord-channel.service',
  switch: './switch-channel.service',
};

const DEFAULT_DRIVER = 'baileys';

// Drivers that require a formal business registration / app-review process —
// the thing that actually makes a channel "production-grade" here. Every
// driver NOT in this list is sandbox-tier by default. Slack and Discord have
// no such process (neither has a review gate like WhatsApp Business
// verification for the permission scopes this bot needs), so both are
// listed here — usable in BOTH sandbox and production, unlike Baileys which
// stays sandbox-only. (Discord's MESSAGE_CONTENT privileged intent does need
// Discord's own Bot Verification once a bot is in 100+ servers — a separate,
// later operational concern, not a blocker at this deployment's scale.)
// `switch` is listed because a Switch deployment is something an operator
// stands up and controls themselves — there is no third-party review gate of
// any kind, which is the only thing this list is about.
const PRODUCTION_TIER_DRIVERS = ['meta', 'slack', 'discord', 'switch'];

// Additive-channel drivers (Slack, Discord, ...) are never selected via
// CHANNEL_DRIVER — they run alongside whichever WhatsApp-family driver
// (meta|baileys) is active, gated by their own env-var presence (see
// feature-availability.js#resolveActiveChannels). Each gets a wire prefix so
// messaging/index.js's router can tell "slack:U0123ABC" / "discord:9182..."
// apart from a bare WhatsApp phone number without any DB/session lookup.
// WhatsApp itself is intentionally NOT in this map — a bare phone number has
// no prefix and falls through to the single resolved CHANNEL_DRIVER, unchanged.
const CHANNEL_PREFIXES = {
  slack: 'slack',
  discord: 'discord',
  switch: 'switch',
};

/**
 * The separator inside a Switch identifier, between the room and the person.
 *
 * A Switch identifier is "switch:<room_id>|<participant_id>" because a send
 * needs BOTH: the room is where the message goes, the participant is who the
 * teacher is. Every other channel needs only one id, so only this one is a
 * pair.
 *
 * It is a pipe and not a second colon because a Switch participant id is
 * itself colon-bearing — "@switch-mattermost-<uuid>-user:localhost" — and the
 * agent protocol is explicit that these ids are opaque and must be matched
 * rather than parsed. driverForIdentifier only ever reads up to the FIRST
 * colon, so the colons inside the payload are harmless to routing.
 */
const SWITCH_ID_SEPARATOR = '|';

function isKnownDriver(name) {
  return Object.prototype.hasOwnProperty.call(DRIVERS, name);
}

function isProductionTier(name) {
  return PRODUCTION_TIER_DRIVERS.includes(name);
}

/** The wire prefix an additive-channel driver's identifiers carry (e.g. "slack"), or null for WhatsApp. */
function prefixFor(driverName) {
  return CHANNEL_PREFIXES[driverName] || null;
}

/**
 * Which additive-channel driver owns this identifier, based on its
 * "<prefix>:<id>" shape — or null for a bare WhatsApp phone number (no
 * colon), which the router falls back to the resolved CHANNEL_DRIVER for.
 */
function driverForIdentifier(id) {
  const idx = String(id).indexOf(':');
  if (idx === -1) return null;
  const prefix = String(id).slice(0, idx);
  return Object.keys(CHANNEL_PREFIXES).find((name) => CHANNEL_PREFIXES[name] === prefix) || null;
}

/**
 * Splits a Switch identifier into the room and the person it names.
 * Returns null for anything that is not one, so a caller can branch on shape
 * rather than on a thrown error.
 */
function parseSwitchIdentifier(id) {
  const prefix = `${CHANNEL_PREFIXES.switch}:`;
  const raw = String(id);
  if (!raw.startsWith(prefix)) return null;
  const rest = raw.slice(prefix.length);
  const sep = rest.indexOf(SWITCH_ID_SEPARATOR);
  if (sep === -1) return null;
  const roomId = rest.slice(0, sep);
  const participantId = rest.slice(sep + 1);
  if (!roomId || !participantId) return null;
  return { roomId, participantId };
}

/** Builds the "switch:<room>|<participant>" identifier the router dispatches by. */
function buildSwitchIdentifier(roomId, participantId) {
  return `${CHANNEL_PREFIXES.switch}:${roomId}${SWITCH_ID_SEPARATOR}${participantId}`;
}

module.exports = {
  DRIVERS,
  DEFAULT_DRIVER,
  PRODUCTION_TIER_DRIVERS,
  CHANNEL_PREFIXES,
  SWITCH_ID_SEPARATOR,
  isKnownDriver,
  isProductionTier,
  prefixFor,
  driverForIdentifier,
  parseSwitchIdentifier,
  buildSwitchIdentifier,
};
