/**
 * Switch channel driver — Rumi as an agent in a Switch room.
 *
 * Unlike every other driver here, this one is not a driver for ONE messaging
 * app. A Switch server bridges Slack, Microsoft Teams, Discord, Telegram and
 * Mattermost itself, so Rumi speaks one protocol and reaches all five. What
 * Rumi joins is a *room*: a channel that holds people and several agents
 * together, with shared context, rather than a 1:1 chat with a bot.
 *
 * That difference shows up in exactly two places, and nowhere else:
 *
 *   1. IDENTITY IS A PAIR. `to` arrives as "switch:<room_id>|<participant_id>"
 *      — the room is where a reply goes, the participant is which teacher it
 *      is about. Every other channel needs one id; this one needs both, so
 *      that a lesson plan generated twenty minutes later by a worker can
 *      still be delivered to the right room. See channel-registry.js's
 *      SWITCH_ID_SEPARATOR for why the separator is a pipe and not a colon.
 *
 *   2. ADDRESSING IS NOT IMPLICIT. In a room full of people and agents, a
 *      message is for Rumi only when it says so. That decision is Switch's,
 *      delivered as `payload.addressed`, and it is the inbound adapter's job
 *      — this file only sends.
 *
 * Interactive components degrade to numbered text, the way Baileys does
 * rather than the way Slack does. Slack can render real Block Kit buttons
 * because Slack is one platform; a Switch room may be mirrored into any of
 * five, so the honest common denominator is text, and the numeric-reply
 * machinery (pending-options.js) already exists for exactly this case.
 *
 * Method names/async-ness are parsed statically off meta-channel.service.js's
 * SOURCE — the same mechanism baileys-channel.service.js, slack-channel.service.js
 * and tests/messaging/channel-driver-parity.test.js use. If meta grows a
 * method this file doesn't know about, requiring this file throws immediately
 * (see the assertion loop at the bottom) rather than silently shipping a
 * missing member.
 */

const fs = require('fs');
const path = require('path');
const { logToFile } = require('../../utils/logger');
const { downloadFromR2, extractKeyFromUrl } = require('../../storage/r2');
const { parseSwitchIdentifier } = require('./channel-registry');
const pendingOptions = require('./pending-options');
const {
  renderOptionsAsText,
  resolveLanguageOptions,
  LANGUAGE_MENU_CHROME,
  STYLE_OPTIONS,
  FEATURE_MENU_OPTIONS,
} = require('./menu-text');

const META_SOURCE_PATH = path.join(__dirname, 'meta-channel.service.js');

function parseMembers(src) {
  const members = [];
  const methodRe = /^\s*static\s+(async\s+)?(\w+)\s*\(/gm;
  let m;
  while ((m = methodRe.exec(src))) members.push({ name: m[2], isAsync: !!m[1] });
  return members;
}

const MEMBERS = parseMembers(fs.readFileSync(META_SOURCE_PATH, 'utf-8'));

// Lazy, so requiring this file never opens a stream — matching
// baileys-connection.js's and discord-connection.js's convention.
function conn() {
  // eslint-disable-next-line global-require -- lazy on purpose, see file header
  return require('./switch-connection');
}

/**
 * The room half of an identifier — where a message actually goes.
 * Throws rather than guessing: a Switch send with no room is undeliverable,
 * and a silent no-op here would look like the bot ignoring a teacher.
 */
function roomOf(to) {
  const parsed = parseSwitchIdentifier(to);
  if (!parsed) {
    throw new Error(
      `Switch channel driver: "${to}" is not a switch identifier. `
      + 'Expected "switch:<room_id>|<participant_id>" — minted by switch-events.adapter.js.'
    );
  }
  return parsed.roomId;
}

/** The person half — who the teacher is, independent of which room they spoke in. */
function participantOf(to) {
  const parsed = parseSwitchIdentifier(to);
  return parsed ? parsed.participantId : null;
}

// ── Media ────────────────────────────────────────────────────────────────────

function isAbsoluteHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

function isR2Configured() {
  return Boolean(
    process.env.R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY
  );
}

/**
 * Resolves a media reference into a Buffer. Switch's upload route is
 * multipart — it takes bytes, never a URL it fetches for you — so unlike
 * Baileys' resolveMediaSource this always materialises the content.
 */
async function resolveMediaBuffer(url) {
  if (Buffer.isBuffer(url)) return url;

  if (isAbsoluteHttpUrl(url)) {
    // An R2 URL for a private bucket is not publicly fetchable; go through the
    // signed client, exactly as the Slack driver does for the same reason.
    if (isR2Configured()) {
      const key = extractKeyFromUrl(url);
      if (key) {
        try {
          return await downloadFromR2(key);
        } catch (error) {
          logToFile('Switch: R2 download failed, falling back to plain fetch', { error: error.message });
        }
      }
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  return fs.promises.readFile(url);
}

function filenameFor(url, fallback) {
  if (Buffer.isBuffer(url)) return fallback;
  try {
    const base = path.basename(new URL(String(url)).pathname);
    return base || fallback;
  } catch {
    return path.basename(String(url)) || fallback;
  }
}

function mimeFromName(name, fallback = 'application/octet-stream') {
  const ext = path.extname(String(name)).toLowerCase();
  const map = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.mp4': 'video/mp4',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return map[ext] || fallback;
}

// ── Text ─────────────────────────────────────────────────────────────────────

function removeEmotionTags(text) {
  return String(text || '').replace(/\[[^\]]*\]/g, '').trim();
}

/**
 * Records the menu so a teacher's "2" can be resolved back to an option id.
 * Keyed on the FULL identifier (room included), because the same teacher can
 * hold a different menu in two rooms at once.
 */
async function rememberMenu(to, replyType, options) {
  const withIds = (options || []).filter((o) => o && o.id);
  if (!withIds.length) return;
  await pendingOptions.remember(String(to), {
    replyType,
    options: withIds.map((o) => ({ id: o.id, title: o.title })),
  });
}

// ── Sends ────────────────────────────────────────────────────────────────────

async function sendMessage(to, message) {
  try {
    await conn().postMessage(roomOf(to), removeEmotionTags(message));
    return true;
  } catch (error) {
    logToFile('❌ Switch: sendMessage failed', { error: error.message, to });
    return false;
  }
}

async function sendTextReturningId(to, message) {
  try {
    const res = await conn().postMessage(roomOf(to), removeEmotionTags(message));
    return res?.event_id || null;
  } catch (error) {
    logToFile('❌ Switch: sendTextReturningId failed', { error: error.message, to });
    return null;
  }
}

/**
 * Switch has no reaction operation on the agent protocol — a reaction is a
 * platform affordance the bridges own, not something an agent posts. Returns
 * false rather than throwing so the ❤️/👍 acknowledgement Rumi sends on every
 * inbound message degrades to nothing visible instead of an error.
 */
async function sendReaction() {
  return false;
}

/**
 * Typing is a real agent-protocol route (POST /agents/{id}/typing), so this is
 * a genuine indicator rather than a stub.
 */
async function showTypingIndicator(to) {
  try {
    await conn().api(`/agents/${conn().getAgentId()}/typing`, {
      method: 'POST',
      body: { room_id: roomOf(to), typing: true },
    });
    return true;
  } catch {
    return false; // never worth failing a message over
  }
}

function startContinuousTypingIndicator(to) {
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    Promise.resolve(showTypingIndicator(to)).catch(() => {});
  };
  tick();
  const interval = setInterval(tick, 8000);
  if (typeof interval.unref === 'function') interval.unref();
  return {
    stop: () => { stopped = true; clearInterval(interval); },
  };
}

/**
 * Inbound media ids are minted by the adapter as
 * "switch:<room_id>|mxc=<uri>" so the router can dispatch them here (every
 * send/fetch method is routed by inspecting its first argument). getMediaInfo
 * has nothing extra to report beyond what the event already carried, so it
 * returns the shape callers expect without a round trip.
 */
async function getMediaInfo(mediaId) {
  const parsed = parseSwitchIdentifier(mediaId);
  if (!parsed) return null;
  return { id: mediaId, mime_type: 'application/octet-stream', url: parsed.participantId };
}

async function downloadMedia(mediaId) {
  const parsed = parseSwitchIdentifier(mediaId);
  if (!parsed) return null;
  const mxc = parsed.participantId.replace(/^mxc=/, '');
  try {
    const { buffer } = await conn().downloadMedia(parsed.roomId, mxc);
    return buffer;
  } catch (error) {
    logToFile('❌ Switch: downloadMedia failed', { error: error.message, mediaId });
    return null;
  }
}

async function uploadAndSend(to, source, { filename, mimeType, caption } = {}) {
  const roomId = roomOf(to);
  const buffer = await resolveMediaBuffer(source);
  const name = filename || filenameFor(source, 'attachment');
  await conn().uploadMedia(roomId, buffer, name, mimeType || mimeFromName(name), caption);
  return true;
}

async function sendDocument(to, filePath, filename, caption) {
  try {
    return await uploadAndSend(to, filePath, { filename: filename || filenameFor(filePath, 'document'), caption });
  } catch (error) {
    logToFile('❌ Switch: sendDocument failed', { error: error.message, to });
    return false;
  }
}

async function sendDocumentFromUrl(to, documentUrl, filename, caption) {
  try {
    return await uploadAndSend(to, documentUrl, { filename: filename || filenameFor(documentUrl, 'document.pdf'), caption });
  } catch (error) {
    logToFile('❌ Switch: sendDocumentFromUrl failed', { error: error.message, to });
    return false;
  }
}

async function sendAudio(to, audioBuffer) {
  try {
    return await uploadAndSend(to, audioBuffer, { filename: 'voice.ogg', mimeType: 'audio/ogg' });
  } catch (error) {
    logToFile('❌ Switch: sendAudio failed', { error: error.message, to });
    return false;
  }
}

async function sendAudioFromUrl(to, audioUrl) {
  try {
    return await uploadAndSend(to, audioUrl, { filename: filenameFor(audioUrl, 'voice.mp3') });
  } catch (error) {
    logToFile('❌ Switch: sendAudioFromUrl failed', { error: error.message, to });
    return false;
  }
}

async function sendAudioFromUrlReturningId(to, audioUrl) {
  const ok = await sendAudioFromUrl(to, audioUrl);
  return ok ? `switch-audio-${Date.now()}` : null;
}

async function sendImage(to, mediaIdOrPath, caption = '') {
  try {
    return await uploadAndSend(to, mediaIdOrPath, { filename: filenameFor(mediaIdOrPath, 'image.png'), caption });
  } catch (error) {
    logToFile('❌ Switch: sendImage failed', { error: error.message, to });
    return false;
  }
}

async function sendImageFromUrl(to, imageUrl, caption = '') {
  return sendImage(to, imageUrl, caption);
}

async function sendVideo(to, videoBuffer, tempDir, caption = '') {
  try {
    return await uploadAndSend(to, videoBuffer, { filename: 'video.mp4', mimeType: 'video/mp4', caption });
  } catch (error) {
    logToFile('❌ Switch: sendVideo failed', { error: error.message, to });
    return false;
  }
}

async function sendVideoFromUrl(to, videoUrl, caption = '') {
  try {
    return await uploadAndSend(to, videoUrl, { filename: filenameFor(videoUrl, 'video.mp4'), caption });
  } catch (error) {
    logToFile('❌ Switch: sendVideoFromUrl failed', { error: error.message, to });
    return false;
  }
}

/** A sticker is just a small image here — no platform-neutral sticker concept exists. */
async function sendSticker(to, mediaIdOrPath) {
  return sendImage(to, mediaIdOrPath, '');
}

// ── Interactive (degraded to numbered text) ──────────────────────────────────

async function sendInteractiveButtons(to, options) {
  try {
    const { body, buttons } = options;
    const text = renderOptionsAsText({ body, options: (buttons || []).map((b) => ({ title: b.title })) });
    await rememberMenu(to, 'button_reply', buttons);
    return await sendMessage(to, text);
  } catch (error) {
    logToFile('❌ Switch: sendInteractiveButtons failed', { error: error.message, to });
    return false;
  }
}

async function sendImageWithButtons(to, imageUrl, bodyText, buttons) {
  try {
    const caption = renderOptionsAsText({ body: bodyText, options: (buttons || []).map((b) => ({ title: b.title })) });
    await rememberMenu(to, 'button_reply', buttons);
    return await sendImage(to, imageUrl, caption);
  } catch (error) {
    logToFile('❌ Switch: sendImageWithButtons failed', { error: error.message, to });
    return false;
  }
}

async function sendInteractiveMessage(to, listData) {
  try {
    const { header, body, footer, action } = listData || {};
    const options = (action?.sections || []).flatMap((s) => s.rows || []);
    const text = renderOptionsAsText({ header, body, footer, options });
    await rememberMenu(to, 'list_reply', options);
    return await sendMessage(to, text);
  } catch (error) {
    logToFile('❌ Switch: sendInteractiveMessage failed', { error: error.message, to });
    return false;
  }
}

async function sendLanguageSelectionList(to, currentLanguage = 'en', region = null) {
  try {
    // Read per region rather than hardcoded — see menu-text.js's header for
    // the bug that rule exists to prevent.
    const options = await resolveLanguageOptions(region);
    const text = renderOptionsAsText({ ...LANGUAGE_MENU_CHROME, options });
    await rememberMenu(to, 'list_reply', options);
    return await sendMessage(to, text);
  } catch (error) {
    logToFile('❌ Switch: sendLanguageSelectionList failed', { error: error.message, to });
    return false;
  }
}

async function sendStyleListFallback(to) {
  try {
    const text = renderOptionsAsText({ header: '🎨 Choose Video Style', options: STYLE_OPTIONS });
    await rememberMenu(to, 'list_reply', STYLE_OPTIONS);
    return await sendMessage(to, text);
  } catch (error) {
    logToFile('❌ Switch: sendStyleListFallback failed', { error: error.message, to });
    return false;
  }
}

async function sendFeatureMenuListFallback(to) {
  try {
    const text = renderOptionsAsText({ header: "Here's what I can do!", options: FEATURE_MENU_OPTIONS });
    await rememberMenu(to, 'list_reply', FEATURE_MENU_OPTIONS);
    return await sendMessage(to, text);
  } catch (error) {
    logToFile('❌ Switch: sendFeatureMenuListFallback failed', { error: error.message, to });
    return false;
  }
}

/**
 * WhatsApp Flows have no Switch equivalent. The honest substitute is the same
 * one Baileys uses — a text flow, one question per message — which is driven
 * by text-flow.js from the inbound side, not by a sendFlow() call. This stays
 * a stub so any caller branching on its Meta-shaped return value degrades
 * safely rather than throwing.
 */
async function sendFlow() {
  logToFile('Switch channel driver: sendFlow() has no equivalent — Flow-shaped forms run as a text flow '
    + '(see text-flow.js), driven from switch-events.adapter.js rather than by this call.');
  return false;
}

function notSupportedMessage(methodName) {
  return `Switch channel driver: ${methodName}() has no equivalent — it needs the channel-agnostic `
    + 'template registry from docs/onboarding/sandbox-production-design.md §1, which is not built. '
    + "The template's static wording lives only in Meta's registered config, not in this call's arguments.";
}

// ── Explicit method table ────────────────────────────────────────────────────

const IMPLEMENTATIONS = {
  _removeEmotionTags: removeEmotionTags,
  sendMessage,
  sendTextReturningId,
  sendAudioFromUrlReturningId,
  sendReaction,
  showTypingIndicator,
  startContinuousTypingIndicator,
  getMediaInfo,
  downloadMedia,
  sendDocument,
  sendAudio,
  sendDocumentFromUrl,
  sendAudioFromUrl,
  sendImageFromUrl,
  sendVideo,
  sendVideoFromUrl,
  sendImage,
  sendSticker,
  sendInteractiveButtons,
  sendImageWithButtons,
  sendInteractiveMessage,
  sendFlow,
  sendLanguageSelectionList,
  sendStyleListFallback,
  sendFeatureMenuListFallback,
};

// name -> whether the real (Meta) method is async, so the stub shape matches.
const STUBS = {
  sendTemplate: true,
  sendStyleCarousel: true,
  sendFeatureMenuCarousel: true,
  buildStyleCarouselPayload: false,
  buildFeatureMenuCarouselPayload: false,
};

function asyncFalseStub(methodName) {
  return async function switchStub() {
    logToFile(notSupportedMessage(methodName), { methodName, driver: 'switch' });
    return false;
  };
}

function syncNullStub(methodName) {
  return function switchSyncStub() {
    logToFile(notSupportedMessage(methodName), { methodName, driver: 'switch' });
    return null;
  };
}

const SwitchChannel = {};

for (const { name, isAsync } of MEMBERS) {
  if (Object.prototype.hasOwnProperty.call(IMPLEMENTATIONS, name)) {
    SwitchChannel[name] = IMPLEMENTATIONS[name];
  } else if (Object.prototype.hasOwnProperty.call(STUBS, name)) {
    const stubIsAsync = STUBS[name];
    if (stubIsAsync !== isAsync) {
      throw new Error(
        `switch-channel.service.js: "${name}" is registered as ${stubIsAsync ? 'async' : 'sync'} in STUBS but `
        + `meta-channel.service.js now declares it ${isAsync ? 'async' : 'sync'} — update STUBS to match.`
      );
    }
    SwitchChannel[name] = stubIsAsync ? asyncFalseStub(name) : syncNullStub(name);
  } else {
    throw new Error(
      `switch-channel.service.js: meta-channel.service.js declares "${name}" with no matching entry in `
      + 'IMPLEMENTATIONS or STUBS. Add one so this driver never silently lacks a method the rest of the bot calls.'
    );
  }
}

SwitchChannel._roomOf = roomOf;
SwitchChannel._participantOf = participantOf;
SwitchChannel._renderOptionsAsText = renderOptionsAsText;
// The relay needs the real implementations by name to run a worker's send in
// the bot process — see switch-outbound-relay.js.
SwitchChannel._localImplementations = IMPLEMENTATIONS;

module.exports = SwitchChannel;
