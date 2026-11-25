import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { paywayHash } from '../../src/modules/payments/payway/hash.js';
import { CHECK_FIELDS, PURCHASE_FIELDS, QR_FIELDS } from '../../src/modules/payments/payway/mapping.js';
import { PayWayProvider } from '../../src/modules/payments/payway/client.js';

const KEY = 'test-api-key';
const cfg = {
  merchantId: 'sportcastle',
  apiKey: KEY,
  baseUrl: 'https://checkout-sandbox.payway.com.kh',
  returnUrl: 'https://api.shop.example/v1/webhooks/payway',
  continueUrl: 'https://shop.example/checkout/return',
};
const input = {
  tranId: 'SC26117Q4K9-1',
  method: 'aba_khqr' as const,
  amountCents: 1250,
  expiresAt: new Date(Date.now() + 30 * 60_000),
  customer: { firstName: 'Sok', lastName: 'Dara', phone: '+85512345678', email: null },
  items: [{ name: 'Jersey', qty: 1, priceCents: 1250 }],
};

const independentHash = (fields: readonly string[], body: Record<string, string>) =>
  createHmac('sha512', KEY).update(fields.map((f) => body[f] ?? '').join('')).digest('base64');

function recorder(response: unknown, status = 200) {
  const calls: { url: string; body: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(response), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('paywayHash', () => {
  it('is base64 HMAC-SHA512 of the concatenated values', () => {
    expect(paywayHash(['a', 'b'], 'k')).toBe(createHmac('sha512', 'k').update('ab').digest('base64'));
  });
});

describe('PayWayProvider', () => {
  it('requests a KHQR with every field signed', async () => {
    const { calls, fetchImpl } = recorder({ status: { code: '0' }, qrString: '000201...', abapay_deeplink: 'abamobilebank://x' });
    const provider = new PayWayProvider(cfg, fetchImpl);
    const { instructions } = await provider.createTransaction(input);
    expect(instructions).toMatchObject({ kind: 'qr', qrString: '000201...', deeplink: 'abamobilebank://x' });
    const [call] = calls;
    expect(call!.url).toBe('https://checkout-sandbox.payway.com.kh/api/payment-gateway/v1/payments/generate-qr');
    expect(call!.body).toMatchObject({ merchant_id: 'sportcastle', tran_id: 'SC26117Q4K9-1', amount: '12.50', currency: 'USD', payment_option: 'abapay_khqr' });
    expect(Buffer.from(call!.body.callback_url!, 'base64').toString()).toBe(cfg.returnUrl);
    expect(call!.body.req_time).toMatch(/^\d{14}$/);
    expect(call!.body.hash).toBe(independentHash(QR_FIELDS, call!.body));
  });

  it('builds a signed card checkout form', async () => {
    const { calls, fetchImpl } = recorder({});
    const provider = new PayWayProvider(cfg, fetchImpl);
    const { instructions } = await provider.createTransaction({ ...input, method: 'card' });
    expect(calls).toHaveLength(0);
    expect(instructions).toMatchObject({ kind: 'redirect', method: 'POST', url: 'https://checkout-sandbox.payway.com.kh/api/payment-gateway/v1/payments/purchase' });
    if (instructions.kind !== 'redirect') throw new Error('expected redirect');
    expect(instructions.fields).toMatchObject({ payment_option: 'cards', amount: '12.50', tran_id: 'SC26117Q4K9-1' });
    expect(instructions.fields.hash).toBe(independentHash(PURCHASE_FIELDS, instructions.fields));
  });

  it.each([
    ['APPROVED', 'approved'],
    ['PENDING', 'pending'],
    ['DECLINED', 'declined'],
    ['REFUNDED', 'refunded'],
    ['CANCELLED', 'cancelled'],
  ])('maps check-transaction %s to %s', async (remote, local) => {
    const { calls, fetchImpl } = recorder({ status: { code: '00' }, data: { payment_status: remote, total_amount: '12.50' } });
    const check = await new PayWayProvider(cfg, fetchImpl).checkTransaction('SC26117Q4K9-1');
    expect(check).toMatchObject({ status: local, amountCents: 1250 });
    expect(calls[0]!.url).toContain('/check-transaction-2');
    expect(calls[0]!.body.hash).toBe(independentHash(CHECK_FIELDS, calls[0]!.body));
  });

  it('treats an unknown transaction (e.g. an abandoned card checkout) as pending, not an error', async () => {
    const { fetchImpl } = recorder({ status: { code: '4', message: 'Transaction not found' } });
    expect(await new PayWayProvider(cfg, fetchImpl).checkTransaction('SC26117Q4K9-1')).toMatchObject({ status: 'pending', amountCents: null });
  });

  it('treats an unknown status string as pending', async () => {
    const { fetchImpl } = recorder({ status: { code: '00' }, data: { payment_status: 'SOMETHING_NEW' } });
    expect((await new PayWayProvider(cfg, fetchImpl).checkTransaction('x')).status).toBe('pending');
  });

  it('turns an HTTP failure into payment_provider_error', async () => {
    const { fetchImpl } = recorder({ error: 'boom' }, 500);
    await expect(new PayWayProvider(cfg, fetchImpl).checkTransaction('x')).rejects.toMatchObject({ code: 'payment_provider_error', status: 502 });
  });

  it('turns a network failure into payment_provider_error', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(new PayWayProvider(cfg, fetchImpl).createTransaction(input)).rejects.toMatchObject({ code: 'payment_provider_error' });
  });

  it('turns a rejected QR request into payment_provider_error', async () => {
    const { fetchImpl } = recorder({ status: { code: '1', message: 'Wrong hash' } });
    await expect(new PayWayProvider(cfg, fetchImpl).createTransaction(input)).rejects.toMatchObject({ code: 'payment_provider_error' });
  });

  describe('verifyWebhook', () => {
    const provider = new PayWayProvider(cfg, recorder({}).fetchImpl);
    it('accepts a well-formed pushback and names the event', () => {
      const v = provider.verifyWebhook(Buffer.from(JSON.stringify({ tran_id: 'SC26117Q4K9-1', apv: '123456', status: '0' })), {});
      expect(v).toMatchObject({ valid: true, tranId: 'SC26117Q4K9-1', eventId: 'SC26117Q4K9-1:0:123456', claimedStatus: 'approved' });
    });
    it('rejects garbage', () => {
      expect(provider.verifyWebhook(Buffer.from('not json'), {}).valid).toBe(false);
      expect(provider.verifyWebhook(Buffer.from(JSON.stringify({ tran_id: '../etc' })), {}).valid).toBe(false);
    });
    it('checks a hash when PayWay sends one', () => {
      const body = { tran_id: 'SC26117Q4K9-1', apv: '1', status: '0' };
      const good = { ...body, hash: paywayHash([body.tran_id, body.apv, body.status], KEY) };
      expect(provider.verifyWebhook(Buffer.from(JSON.stringify(good)), {}).valid).toBe(true);
      expect(provider.verifyWebhook(Buffer.from(JSON.stringify({ ...body, hash: 'bad' })), {}).valid).toBe(false);
    });
  });
});
