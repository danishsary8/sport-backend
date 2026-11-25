import { postJson, type Notifier } from './notifier.js';

/** Ops alerts to the shop's Telegram chat (`to: 'ops'`). */
export function telegramNotifier(cfg: { botToken?: string; chatId?: string }, fetchImpl: typeof fetch = fetch): Notifier {
  const configured = Boolean(cfg.botToken && cfg.chatId);
  return {
    channel: 'telegram',
    configured,
    async send(message) {
      if (!configured) throw new Error('Telegram is not configured');
      const chatId = message.to === 'ops' ? cfg.chatId! : message.to;
      await postJson(fetchImpl, `https://api.telegram.org/bot${encodeURIComponent(cfg.botToken!)}/sendMessage`, {
        chat_id: chatId,
        text: message.text,
        disable_web_page_preview: true,
      });
    },
  };
}
