/**
 * menu.service.js — the /menu command's routing. Covers the two behaviors
 * added when /menu became clickable on Slack/Discord: a Quiz option that
 * delegates to QuizOrchestrator (the same entry point /quiz itself uses),
 * and a per-channel branch for Reading Assessment (Discord has its own
 * modal-workaround flow; everyone else — including Slack, which has no
 * renderer yet — goes through the existing Flow-shaped call).
 */

jest.mock('../../bot/shared/config/supabase', () => ({ from: jest.fn() }), { virtual: true });
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/database/bot-helpers', () => ({ storeConversation: jest.fn() }));
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  get: jest.fn(),
  set: jest.fn(),
  delete: jest.fn(),
}));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn().mockResolvedValue(true),
  sendInteractiveButtons: jest.fn().mockResolvedValue(true),
  sendFlow: jest.fn().mockResolvedValue(true),
  sendFeatureMenuCarousel: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../bot/shared/services/feature-intro.service', () => ({
  sendFirstUseIntroIfNeeded: jest.fn().mockResolvedValue(undefined),
  markFeatureUsed: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../bot/shared/services/quiz/quiz-orchestrator.service', () => ({
  initiateQuizRequest: jest.fn().mockResolvedValue(undefined),
}));

const MenuService = require('../../bot/shared/services/menu.service');
const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const redisService = require('../../bot/shared/services/cache/railway-redis.service');
const FeatureIntroService = require('../../bot/shared/services/feature-intro.service');
const QuizOrchestrator = require('../../bot/shared/services/quiz/quiz-orchestrator.service');

const USER = { id: 'user-1' };
const STATE = { sessionId: 'session-1', from: null, language: 'en', askedAt: '2026-01-01T00:00:00.000Z' };

beforeEach(() => {
  jest.clearAllMocks();
  redisService.get.mockResolvedValue({ ...STATE });
});

describe('handleMenuButtonResponse — menu_quiz', () => {
  it('delegates to QuizOrchestrator.initiateQuizRequest with the full user object, the awaited session, and no pre-supplied topic', async () => {
    await MenuService.handleMenuButtonResponse(USER, '923001234567', 'menu_quiz', 'en');

    expect(QuizOrchestrator.initiateQuizRequest).toHaveBeenCalledWith(
      USER, '923001234567', 'session-1', 'en', null
    );
  });

  it('clears the awaiting-menu-selection state before delegating, same as every other menu choice', async () => {
    await MenuService.handleMenuButtonResponse(USER, '923001234567', 'menu_quiz', 'en');
    expect(redisService.delete).toHaveBeenCalledWith('user:user-1:awaiting_menu_selection');
  });
});

describe('handleMenuButtonResponse — menu_reading', () => {
  it('routes a Discord identifier to the discord_start_flow:reading_assessment button instead of a WhatsApp Flow', async () => {
    await MenuService.handleMenuButtonResponse(USER, 'discord:12345', 'menu_reading', 'en');

    expect(WhatsAppService.sendInteractiveButtons).toHaveBeenCalledWith('discord:12345', {
      body: expect.stringContaining('reading assessment'),
      buttons: [{ id: 'discord_start_flow:reading_assessment', title: 'Start Assessment' }],
    });
    expect(WhatsAppService.sendFlow).not.toHaveBeenCalled();
    expect(FeatureIntroService.markFeatureUsed).toHaveBeenCalledWith('user-1', 'reading');
  });

  it('routes a bare WhatsApp number to the existing sendFlow call, unchanged', async () => {
    await MenuService.handleMenuButtonResponse(USER, '923001234567', 'menu_reading', 'en');

    expect(WhatsAppService.sendFlow).toHaveBeenCalledWith('923001234567', expect.objectContaining({
      flowId: process.env.READING_ASSESSMENT_FLOW_ID,
      screen: 'BASIC_INFO',
    }));
    expect(WhatsAppService.sendInteractiveButtons).not.toHaveBeenCalled();
    expect(FeatureIntroService.markFeatureUsed).toHaveBeenCalledWith('user-1', 'reading');
  });

  it('routes a Slack identifier to sendFlow too — no Slack reading_assessment renderer exists yet', async () => {
    await MenuService.handleMenuButtonResponse(USER, 'slack:U0123ABC', 'menu_reading', 'en');

    expect(WhatsAppService.sendFlow).toHaveBeenCalled();
    expect(WhatsAppService.sendInteractiveButtons).not.toHaveBeenCalled();
  });

  it('sends the first-use intro before either branch, on every channel', async () => {
    await MenuService.handleMenuButtonResponse(USER, 'discord:12345', 'menu_reading', 'en');
    expect(FeatureIntroService.sendFirstUseIntroIfNeeded).toHaveBeenCalledWith('user-1', 'discord:12345', 'reading', 'en');
  });

  it('degrades to an honest "not set up" message (not a generic error) when sendFlow fails for a non-Discord channel', async () => {
    // Regression test: this used to throw and surface "Something went
    // wrong", which reads as a bug rather than as a feature that isn't
    // configured — confirmed live on Slack, matching the exact fix already
    // applied to text-message.handler.js's own /readingtest command.
    WhatsAppService.sendFlow.mockResolvedValueOnce(false);
    await MenuService.handleMenuButtonResponse(USER, '923001234567', 'menu_reading', 'en');
    expect(WhatsAppService.sendMessage).toHaveBeenCalledWith('923001234567', expect.stringContaining('not set up on this deployment yet'));
  });

  it('degrades in Urdu when the teacher\'s language is Urdu', async () => {
    WhatsAppService.sendFlow.mockResolvedValueOnce(false);
    await MenuService.handleMenuButtonResponse(USER, '923001234567', 'menu_reading', 'ur');
    expect(WhatsAppService.sendMessage).toHaveBeenCalledWith('923001234567', expect.stringContaining('ریڈنگ اسسمنٹ'));
  });
});
