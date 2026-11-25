import { describe, expect, it } from 'vitest';
import { resendNotifier } from '../../src/modules/notifications/resend.js';
import { telegramNotifier } from '../../src/modules/notifications/telegram.js';

function recorder(status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response('{}', { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('telegramNotifier', () => {
  it('posts the message to the ops chat', async () => {
    const { calls, fetchImpl } = recorder();
    const n = telegramNotifier({ botToken: 'T0K', chatId: '-100' }, fetchImpl);
    await n.send({ channel: 'telegram', to: 'ops', subject: 's', text: 'hello' });
    expect(calls[0]!.url).toBe('https://api.telegram.org/botT0K/sendMessage');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ chat_id: '-100', text: 'hello', disable_web_page_preview: true });
  });

  it('throws on a non-2xx answer and reports when unconfigured', async () => {
    await expect(telegramNotifier({ botToken: 't', chatId: 'c' }, recorder(500).fetchImpl).send({ channel: 'telegram', to: 'ops', subject: '', text: 'x' })).rejects.toThrow();
    expect(telegramNotifier({}).configured).toBe(false);
  });
});

describe('resendNotifier', () => {
  it('sends with the API key', async () => {
    const { calls, fetchImpl } = recorder();
    await resendNotifier({ apiKey: 'RK', from: 'Shop <s@example.com>' }, fetchImpl).send({ channel: 'email', to: 'a@b.c', subject: 'Hi', text: 't', html: '<p>t</p>' });
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer RK');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ from: 'Shop <s@example.com>', to: ['a@b.c'], subject: 'Hi', text: 't', html: '<p>t</p>' });
  });

  it('throws on a non-2xx answer and reports when unconfigured', async () => {
    await expect(resendNotifier({ apiKey: 'k', from: 'f@x.y' }, recorder(422).fetchImpl).send({ channel: 'email', to: 'a@b.c', subject: '', text: '' })).rejects.toThrow();
    expect(resendNotifier({ apiKey: 'k' }).configured).toBe(false);
  });
});
