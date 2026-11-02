-- Fix: a lesson plan requested from Discord could never be created.
--
-- lesson_plan_requests still carried the pre-multi-channel shape
-- (phone_number VARCHAR(20) NOT NULL) while text-message.handler.js passed it
-- the full prefixed channel identifier as `phoneNumber`:
--
--   bare WhatsApp phone number                 = 12 chars    -> fits
--   "slack:"   (6) + 9-11 char Slack user id   = 17 chars    -> fits, barely
--   "discord:" (8) + 17-19 digit snowflake     = 25-27 chars -> REJECTED
--
-- Postgres rejects an oversize varchar rather than truncating, so the INSERT
-- threw, createAndQueue turned it into "Failed to create lesson plan request",
-- and the teacher — who had already been told "I'm preparing a detailed
-- five-step lesson plan for you" — got "Sorry, there was an error creating
-- the lesson plan. Please try again." Every time, for every Discord user.
-- Slack fitting with three characters to spare is why this reached production.
--
-- The fix follows the convention coaching_sessions, exam_check_sessions and
-- video_requests already use, and which lesson_plan_requests was simply
-- missed by: a background job delivers to the recipient_identifier captured
-- when the request was made, never to a re-derived users.phone_number.

ALTER TABLE lesson_plan_requests
  ADD COLUMN IF NOT EXISTS recipient_identifier VARCHAR(255);

COMMENT ON COLUMN lesson_plan_requests.recipient_identifier IS
  'The exact channel identifier that originated this request (a bare WhatsApp '
  'phone number, or a "slack:<id>" / "discord:<id>" / "switch:<room>|<participant>" '
  'prefixed identifier — whatever messaging/index.js routes on). The worker '
  'delivers here. Never re-derive the recipient from users.phone_number: that '
  'is WhatsApp-only and sends a Discord-originated plan nowhere.';

-- A teacher who reaches Rumi on Discord or Switch has no phone number to
-- record, and this column is no longer what delivery reads.
ALTER TABLE lesson_plan_requests
  ALTER COLUMN phone_number DROP NOT NULL;

-- Backfill: every existing row's identifier is whatever is already in
-- phone_number — correct for the WhatsApp and Slack rows that are the only
-- ones that can exist, since a Discord row could never be inserted.
UPDATE lesson_plan_requests
   SET recipient_identifier = phone_number
 WHERE recipient_identifier IS NULL
   AND phone_number IS NOT NULL;
