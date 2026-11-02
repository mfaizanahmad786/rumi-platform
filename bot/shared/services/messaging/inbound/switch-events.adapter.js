/**
 * Switch inbound adapter — translates agent-protocol events into the same
 * Meta-webhook-shaped payload bot/whatsapp-bot.js's handleWebhookPost(req, res)
 * already parses. Mirrors baileys-socket.adapter.js's role: a parallel entry
 * path into the existing ~1000-line dispatch logic, not a rewrite of it.
 *
 * Like Baileys and unlike Slack, Switch is a persistent stream rather than a
 * webhook, so this adapter is an `attach(dispatch)` subscription on
 * switch-connection.js's `events` emitter — not an Express route handler.
 *
 * ── The one rule that is unique to this channel ──────────────────────────────
 * A Switch room holds many people and often several agents. Every message in
 * it reaches Rumi's stream, and acting on all of them would have Rumi barge
 * into colleagues' conversations. `payload.addressed` is Switch's answer to
 * "is this for you", computed server-side from the mention, the room's
 * aliases and any role Rumi holds — and it is the ONLY thing this adapter
 * acts on. Delivery and acting are different things.
 *
 * (The stream is opened with filter=all rather than filter=addressed on
 * purpose: a connection filtered to `addressed` is never sent `command`
 * events at all, and Rumi's slash commands arrive as exactly those.)
 *
 * ── Identity ─────────────────────────────────────────────────────────────────
 * `from` is always "switch:<room_id>|<participant_id>" — minted HERE, the one
 * place Switch identities enter the system, then carried unchanged through
 * getOrCreateUserByChannel and every downstream send. The room travels inside
 * the identifier because a reply may be sent minutes later by a worker
 * process that has nothing but that string (see switch-outbound-relay.js).
 * The participant half alone is what identifies the teacher, so a teacher
 * keeps one history across every room they speak in — see
 * whatsapp-bot.js#resolveChannelIdentity.
 */

const { logToFile } = require('../../../utils/logger');
const { buildSwitchIdentifier } = require('../channel-registry');
const connection = require('../switch-connection');
const switchChannel = require('../switch-channel.service');
const pendingOptions = require('../pending-options');
const textFlow = require('../text-flow');

// A stable, non-test, non-zero entry id — passes validators.isTestWebhook().
const SYNTHETIC_ENTRY_ID = 'switch-events';

const AUDIO_MIME_RE = /^audio\//i;
const IMAGE_MIME_RE = /^image\//i;

/**
 * Media ids carry the room as well, because the router dispatches
 * getMediaInfo/downloadMedia by inspecting the id argument for a channel
 * prefix, and the download route is per-room. "mxc=" marks the second half as
 * a media URI rather than a participant.
 */
function toPrefixedMediaId(roomId, mxc) {
  return buildSwitchIdentifier(roomId, `mxc=${mxc}`);
}

// Switch redelivers on reconnect: the event buffer is replayed from the
// cursor, and a `gap` or a restart can re-present an event we already acted
// on. Same redelivery class Baileys and Slack guard against, same fix shape.
const SEEN_EVENT_TTL_MS = 5 * 60 * 1000;
const seenEventIds = new Map();

function isDuplicateDelivery(id) {
  if (!id) return false;
  const now = Date.now();
  for (const [seenId, seenAt] of seenEventIds) {
    if (now - seenAt > SEEN_EVENT_TTL_MS) seenEventIds.delete(seenId);
  }
  if (seenEventIds.has(id)) return true;
  seenEventIds.set(id, now);
  return false;
}

function _resetSeenEventsForTests() {
  seenEventIds.clear();
}

/**
 * Maps one attachment into a Meta-shaped audio/image/document message.
 *
 * An attachment on the event is a POINTER, never bytes — the content is
 * fetched later, on demand, through the media route. Only the first
 * attachment of a group is mapped, matching Meta's one-attachment-per-message
 * model and what the Slack and Baileys adapters already do.
 */
function mapAttachmentToMetaShape(payload, roomId, from, id, timestamp) {
  const file = (payload.attachments || [])[0];
  if (!file || !file.mxc) return null;

  const mediaId = toPrefixedMediaId(roomId, file.mxc);
  const mimeType = file.mimetype || 'application/octet-stream';

  if (AUDIO_MIME_RE.test(mimeType)) {
    return { from, id, timestamp, type: 'audio', audio: { id: mediaId, mime_type: mimeType } };
  }
  if (IMAGE_MIME_RE.test(mimeType)) {
    // A filename-only body is NOT a caption. Meta sends an empty caption when
    // there is none, and the image handler reads a caption as the teacher's
    // instruction — PR #104 hit exactly this on Matrix, where the filename
    // arrived as the instruction.
    const caption = payload.body && payload.body !== file.filename ? payload.body : '';
    return { from, id, timestamp, type: 'image', image: { id: mediaId, mime_type: mimeType, caption } };
  }
  return {
    from, id, timestamp, type: 'document',
    document: { id: mediaId, mime_type: mimeType, filename: file.filename || 'file' },
  };
}

/**
 * Resolves a numbered/name reply against the menu this identity last saw.
 * Mirrors baileys-socket.adapter.js#toInteractiveSelection — Switch has no
 * native buttons, so every menu is numbered text and comes back as text.
 */
async function toInteractiveSelection(from, text) {
  const menu = await pendingOptions.get(from);
  const selected = pendingOptions.resolveSelection(menu, text);
  if (!selected) return null;

  await pendingOptions.clear(from);
  logToFile('🔢 Switch inbound: numeric reply resolved to an interactive selection', {
    from, replyType: menu.replyType, id: selected.id,
  });

  const reply = { id: selected.id, title: selected.title };
  return menu.replyType === 'button_reply'
    ? { type: 'interactive', interactive: { type: 'button_reply', button_reply: reply } }
    : { type: 'interactive', interactive: { type: 'list_reply', list_reply: reply } };
}

/**
 * Whether this message is a command in its own right, and so must never be
 * consumed as an answer to a pending question. Asks the same detector the
 * text handler routes on, so the two cannot drift — see the Baileys adapter's
 * note about "add class" becoming a student's name.
 */
function isCommandLike(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('/')) return true;

  try {
    // eslint-disable-next-line global-require -- keeps this adapter's load light
    const detector = require('../../attendance-detector.service');
    if (detector.detectAddClassIntent(trimmed).detected) return true;
    if (detector.detectAttendanceIntent(trimmed).detected) return true;
  } catch (error) {
    logToFile('⚠️ Switch inbound: command detection unavailable', { error: error.message });
  }
  return false;
}

/**
 * Feeds text into the identity's active text flow — the stand-in for a Meta
 * Flow form, which Switch has no equivalent of.
 *
 * MUST run before toInteractiveSelection(): a text flow records its menu in
 * the same pending-options store, so whichever runs first consumes the reply.
 */
async function advanceActiveTextFlow(from, text) {
  // A flow can outlive the process that started it (state is in Redis), so
  // the definitions must be present before advancing, not only before start.
  // eslint-disable-next-line global-require -- lazy on purpose; see ensureRegistered()
  require('../text-flow-definitions').ensureRegistered();

  const result = await textFlow.advance(from, text);
  if (!result) return null;

  logToFile('🧩 Switch inbound: text-flow reply', {
    from, status: result.status, step: result.render?.kind || null,
  });

  if (result.status === 'cancelled') {
    await switchChannel.sendMessage(from, 'Okay, cancelled. Type /menu to see what else I can do.');
    return { handled: true };
  }
  if (result.status === 'completed' && result.metaMessage) {
    return { metaMessage: result.metaMessage };
  }
  return { handled: true };
}

/**
 * Strips the leading "@rumi" (or whatever alias addressed us) from the body.
 *
 * Every downstream handler was written for WhatsApp, where a teacher's
 * message is just their message. Leaving the mention on changes what the
 * language detector, the topic matcher and the LLM all see — "@rumi fractions
 * for grade 3" is not the same prompt as "fractions for grade 3".
 */
function stripLeadingMention(body) {
  return String(body || '').replace(/^\s*@[\w.-]+[:,]?\s*/, '').trim();
}

/**
 * One domain event -> the Meta-shaped message to dispatch, or null to skip.
 */
async function mapMessageToMetaShape(event) {
  const payload = event.payload || {};
  const roomId = event.room_id;
  if (!roomId || !payload.sender) return null;

  // Never answer ourselves, Switch's own admin output, or a reply Switch
  // generated on our behalf.
  if (payload.sender_kind === 'platform') return null;
  if (payload.sender === `@switch-agent-${connection.getAgentId()}`) return null;

  // THE rule for this channel — see the file header.
  if (!payload.addressed) return null;

  const from = buildSwitchIdentifier(roomId, payload.sender);
  const timestamp = payload.timestamp ? Math.floor(payload.timestamp / 1000) : Math.floor(Date.now() / 1000);
  const id = payload.message_id || String(timestamp);

  if ((payload.attachments || []).length) {
    return mapAttachmentToMetaShape(payload, roomId, from, id, timestamp);
  }

  const text = stripLeadingMention(payload.body);
  if (!text) return null;

  return { from, id, timestamp, type: 'text', text: { body: text } };
}

function buildSyntheticRequest(metaMessage) {
  return {
    body: {
      entry: [{
        id: SYNTHETIC_ENTRY_ID,
        changes: [{
          value: {
            messages: [metaMessage],
            metadata: {}, // no phone_number_id — validators.isOurPhoneNumber() auto-allows when absent
          },
        }],
      }],
    },
  };
}

function buildSyntheticResponse() {
  return {
    status(code) {
      return { send: (body) => logToFile('Switch inbound: synthetic response', { code, body }) };
    },
  };
}

/**
 * Handles one inbound domain event end to end.
 * Exported so the ordering below is testable without a live stream.
 */
async function handleEvent(event, dispatch) {
  if (event.type === 'command') {
    // A room command (!reset, !compact) is Switch's own session control, not
    // something Rumi's dispatch understands. Logged and dropped rather than
    // guessed at.
    logToFile('Switch inbound: room command ignored', { command: event.payload?.command });
    return;
  }
  if (event.type !== 'message') return;

  const metaMessage = await mapMessageToMetaShape(event);
  if (!metaMessage) return;

  if (isDuplicateDelivery(metaMessage.id)) {
    logToFile('⚠️ Switch inbound: duplicate delivery skipped', { messageId: metaMessage.id });
    return;
  }

  const { from } = metaMessage;

  // Ordering matters and mirrors Baileys': a command always wins over an
  // in-flight question; the text flow runs before the numbered-menu resolver
  // because both read the same pending-options store.
  if (metaMessage.type === 'text') {
    const text = metaMessage.text.body;

    if (!isCommandLike(text)) {
      const flowed = await advanceActiveTextFlow(from, text);
      if (flowed?.handled) return;
      if (flowed?.metaMessage) {
        const req = buildSyntheticRequest({ ...flowed.metaMessage, from });
        await dispatch(req, buildSyntheticResponse());
        return;
      }

      const selection = await toInteractiveSelection(from, text);
      if (selection) {
        const req = buildSyntheticRequest({ ...metaMessage, ...selection, text: undefined });
        await dispatch(req, buildSyntheticResponse());
        return;
      }
    }
  }

  await dispatch(buildSyntheticRequest(metaMessage), buildSyntheticResponse());
}

/**
 * @param {(req: object, res: object) => Promise<void>} dispatch  handleWebhookPost from whatsapp-bot.js
 */
async function attach(dispatch) {
  await connection.connect();

  connection.events.on('event', (event) => {
    handleEvent(event, dispatch).catch((error) => {
      logToFile('❌ Switch inbound: error processing event', { error: error.message, stack: error.stack });
    });
  });

  // A gap is not a wake: it means the buffer moved past our cursor, so some
  // events are simply gone. Nothing to replay — say so loudly rather than
  // pretending the stream was continuous.
  connection.events.on('gap', (p) => {
    logToFile('⚠️ Switch inbound: event gap — some room messages were not delivered', p);
  });

  connection.events.on('evicted', (p) => {
    logToFile('🔒 Switch inbound: connection evicted — another process is using this agent\'s '
      + 'connection id. Only the bot process may hold it; workers must use the relay.', p);
  });

  logToFile('✅ Switch inbound listener attached', { agentId: connection.getAgentId() });
}

module.exports = {
  attach,
  handleEvent,
  mapMessageToMetaShape,
  mapAttachmentToMetaShape,
  toInteractiveSelection,
  advanceActiveTextFlow,
  isCommandLike,
  isDuplicateDelivery,
  stripLeadingMention,
  toPrefixedMediaId,
  _resetSeenEventsForTests,
};
