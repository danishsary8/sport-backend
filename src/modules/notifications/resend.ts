import { postJson, type Notifier } from './notifier.js';

/** Customer emails through Resend. */
export function resendNotifier(cfg: { apiKey?: string; from?: string }, fetchImpl: typeof fetch = fetch): Notifier {
  const configured = Boolean(cfg.apiKey && cfg.from);
  return {
    channel: 'email',
    configured,
    async send(message) {
      if (!configured) throw new Error('Email is not configured');
      await postJson(
        fetchImpl,
        'https://api.resend.com/emails',
        { from: cfg.from, to: [message.to], subject: message.subject, text: message.text, ...(message.html ? { html: message.html } : {}) },
        { authorization: `Bearer ${cfg.apiKey}` },
      );
    },
  };
}
