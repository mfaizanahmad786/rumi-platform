/**
 * A lesson plan requested from a non-WhatsApp channel must be creatable, and
 * must be delivered back to the channel it came from.
 *
 * The bug this pins: lesson_plan_requests still carried the pre-multi-channel
 * shape (phone_number VARCHAR(20) NOT NULL) while text-message.handler.js
 * passed it the full prefixed identifier as `phoneNumber`.
 *
 *   bare WhatsApp phone number                 = 12 chars    -> fits
 *   "slack:"   (6) + 9-11 char Slack user id   = 17 chars    -> fits, barely
 *   "discord:" (8) + 17-19 digit snowflake     = 25-27 chars -> rejected
 *   "switch:<room>|<participant>"              = ~114 chars  -> rejected
 *
 * Postgres rejects an oversize varchar rather than truncating, so the INSERT
 * threw and every Discord teacher got "Sorry, there was an error creating the
 * lesson plan. Please try again." — on every attempt. Slack fitting with
 * three characters to spare is why it reached production, and is why the
 * length assertions below are explicit rather than implied: a test that only
 * exercised Slack would have passed throughout.
 *
 * Fix (migration 018) follows the convention coaching_sessions,
 * exam_check_sessions and video_requests already use: delivery reads
 * recipient_identifier, and phone_number goes back to meaning a phone number.
 */

const DISCORD_ID = 'discord:1234567890123456789';   // 19-digit snowflake
const SLACK_ID = 'slack:U01234ABCDE';
const SWITCH_ID = 'switch:2202d944-5596-4f01-b8b6-0915f8509a9e|@switch-mattermost-8cb57433-523e-4fcf-a285-1bef838e7641-user:localhost';
const WHATSAPP_ID = '923001234567';

// The width lesson_plan_requests.phone_number had, and the reason the insert
// failed. Asserted directly so the arithmetic in the comments above is
// checked rather than trusted.
const OLD_COLUMN_WIDTH = 20;

const mockInserted = [];
const mockQueued = [];

jest.mock('../../bot/shared/config/supabase', () => {
  const api = {
    from() { return api; },
    insert(row) { mockInserted.push(row); api._mode = 'insert'; return api; },
    update() { return api; },
    eq() { return api; },
    select() { return api; },
    single() { return Promise.resolve({ data: { id: 'req-1' }, error: null }); },
  };
  return api;
});

jest.mock('../../bot/shared/services/queue', () => ({
  queueCoachingJob: jest.fn((id, type, payload) => {
    mockQueued.push({ id, type, payload });
    return Promise.resolve();
  }),
}));

jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));

const LessonPlanQueueService = require('../../bot/shared/services/lesson-plan-queue.service');

describe('lesson plan requests carry the channel they came from', () => {
  beforeEach(() => {
    mockInserted.length = 0;
    mockQueued.length = 0;
  });

  it('a Discord identifier is longer than the column that used to hold it', () => {
    // The bug, stated as arithmetic. If someone "fixes" this by shortening the
    // prefix rather than storing the identifier properly, this fails loudly.
    expect(DISCORD_ID.length).toBeGreaterThan(OLD_COLUMN_WIDTH);
    expect(SWITCH_ID.length).toBeGreaterThan(OLD_COLUMN_WIDTH);
    // ...and Slack is under it, which is exactly why this went unnoticed.
    expect(SLACK_ID.length).toBeLessThanOrEqual(OLD_COLUMN_WIDTH);
    expect(WHATSAPP_ID.length).toBeLessThanOrEqual(OLD_COLUMN_WIDTH);
  });

  it.each([
    ['Discord', DISCORD_ID],
    ['Switch', SWITCH_ID],
    ['Slack', SLACK_ID],
  ])('stores a %s identifier in recipient_identifier, and NOT in phone_number', async (_name, identifier) => {
    await LessonPlanQueueService.createAndQueue({
      userId: 'u-1', phoneNumber: identifier, topic: 'fractions', fullMessage: 'lesson plan on fractions',
    });

    const row = mockInserted[0];
    expect(row.recipient_identifier).toBe(identifier);
    // The whole point: nothing channel-prefixed goes near the narrow column.
    expect(row.phone_number).toBeNull();
  });

  it('still records a bare WhatsApp number as a phone number', async () => {
    await LessonPlanQueueService.createAndQueue({
      userId: 'u-1', phoneNumber: WHATSAPP_ID, topic: 'fractions', fullMessage: 'x',
    });

    const row = mockInserted[0];
    expect(row.phone_number).toBe(WHATSAPP_ID);
    expect(row.recipient_identifier).toBe(WHATSAPP_ID);
  });

  it('queues the identifier so the worker can deliver back to the right channel', async () => {
    await LessonPlanQueueService.createAndQueue({
      userId: 'u-1', phoneNumber: DISCORD_ID, topic: 'fractions', fullMessage: 'x',
    });

    expect(mockQueued[0].payload.recipientIdentifier).toBe(DISCORD_ID);
    // The old key stays populated so jobs already in flight at deploy time
    // still find a recipient.
    expect(mockQueued[0].payload.phoneNumber).toBe(DISCORD_ID);
  });

  it('requeues a pre-migration row from phone_number when it has no recipient_identifier', async () => {
    await LessonPlanQueueService.requeueRequest({
      id: 'req-old', user_id: 'u-1', phone_number: WHATSAPP_ID, recipient_identifier: null,
      topic: 'fractions', full_message: 'x', language: 'en', content_type: 'lesson_plan',
    });

    expect(mockQueued[0].payload.recipientIdentifier).toBe(WHATSAPP_ID);
  });

  it('requeues a migrated row from recipient_identifier, not phone_number', async () => {
    await LessonPlanQueueService.requeueRequest({
      id: 'req-new', user_id: 'u-1', phone_number: null, recipient_identifier: DISCORD_ID,
      topic: 'fractions', full_message: 'x', language: 'en', content_type: 'lesson_plan',
    });

    expect(mockQueued[0].payload.recipientIdentifier).toBe(DISCORD_ID);
  });
});

describe('the worker delivers to the identifier it was given', () => {
  it('prefers recipientIdentifier and falls back to the pre-migration key', () => {
    // The worker reads `jobData.recipientIdentifier || jobData.phoneNumber`.
    // Asserted as the contract rather than by booting the whole worker, whose
    // generation path needs Gamma, R2 and a live queue.
    const resolve = (job) => job.recipientIdentifier || job.phoneNumber;

    expect(resolve({ recipientIdentifier: DISCORD_ID, phoneNumber: DISCORD_ID })).toBe(DISCORD_ID);
    expect(resolve({ phoneNumber: WHATSAPP_ID })).toBe(WHATSAPP_ID); // in-flight at deploy
    expect(resolve({ recipientIdentifier: SWITCH_ID })).toBe(SWITCH_ID);
  });
});
