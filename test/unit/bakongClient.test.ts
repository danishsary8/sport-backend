import { describe, expect, it } from 'vitest';
import { BAKONG_CHECK_PATH, BakongProvider } from '../../src/modules/payments/bakong/client.js';
import { createPaymentProvider } from '../../src/modules/payments/provider.js';
import { testConfig } from '../helpers/testConfig.js';

const cfg = { token: 'test-token', accountId: 'sportcastle@aba', merchantName: 'Sport Heaven', merchantCity: 'Phnom Penh', apiUrl: 'https://api-bakong.example' };
const now = new Date('2026-11-27T03:00:00Z');
const input = {
  tranId: 'SC2611ABCDE-1',
  method: 'aba_khqr' as const,
  amountCents: 9500,
  expiresAt: new Date(now.getTime() + 30 * 60_000),
  customer: { firstName: 'Sok', lastName: 'Dara', phone: '+85512345678', email: null },
  items: [{ name: 'Jersey', qty: 1, priceCents: 9500 }],
};

function api(answer: unknown, status = 200) {
  const calls: { url: string; auth: string | null; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('BakongProvider', () => {
  it('makes a dynamic KHQR for the order total and keeps its md5 for the payment check', async () => {
    const { calls, fetchImpl } = api({});
    const provider = new BakongProvider(cfg, fetchImpl, () => now);
    const { instructions, raw } = await provider.createTransaction(input);
    expect(calls).toHaveLength(0); // the QR is made locally; nothing is sent to Bakong
    expect(instructions).toMatchObject({ kind: 'qr', deeplink: null, expiresAt: input.expiresAt.toISOString() });
    const qr = (instructions as { qrString: string }).qrString;
    expect(qr).toContain('0015sportcastle@aba');
    expect(qr).toContain('5402955802KH'); // $95, Cambodia
    expect(qr).toContain('0113SC2611ABCDE-1'); // bill number = transaction id
    expect(raw).toEqual({ md5: expect.stringMatching(/^[a-f0-9]{32}$/) });
  });

  it('refuses card payments', async () => {
    const provider = new BakongProvider(cfg, api({}).fetchImpl, () => now);
    await expect(provider.createTransaction({ ...input, method: 'card' })).rejects.toMatchObject({ code: 'payment_method_unavailable' });
    expect(provider.methods).toEqual(['aba_khqr']);
  });

  it('asks Bakong by md5 with the token, and treats "not found" as not paid yet', async () => {
    const { calls, fetchImpl } = api({ responseCode: 1, responseMessage: 'Transaction could not be found', errorCode: 1, data: null });
    const provider = new BakongProvider(cfg, fetchImpl, () => now);
    const md5 = 'a'.repeat(32);
    await expect(provider.checkTransaction('SC1-1', { raw: { md5 } })).resolves.toMatchObject({ status: 'pending', amountCents: null });
    expect(calls).toEqual([{ url: `https://api-bakong.example${BAKONG_CHECK_PATH}`, auth: 'Bearer test-token', body: { md5 } }]);
  });

  it('confirms a payment to the shop account with the amount paid', async () => {
    const { fetchImpl } = api({ responseCode: 0, data: { hash: 'abc', toAccountId: 'SportCastle@ABA', currency: 'USD', amount: 95 } });
    const check = await new BakongProvider(cfg, fetchImpl, () => now).checkTransaction('SC1-1', { raw: { md5: 'b'.repeat(32) } });
    expect(check).toMatchObject({ status: 'approved', amountCents: 9500 });
  });

  it('never confirms a payment that went to another account', async () => {
    const { fetchImpl } = api({ responseCode: 0, data: { toAccountId: 'someone@aba', currency: 'USD', amount: 95 } });
    await expect(new BakongProvider(cfg, fetchImpl, () => now).checkTransaction('SC1-1', { raw: { md5: 'c'.repeat(32) } })).rejects.toMatchObject({ code: 'payment_provider_error' });
  });

  it('reports an amount it cannot compare (not USD) as unknown, so staff check the order', async () => {
    const { fetchImpl } = api({ responseCode: 0, data: { toAccountId: 'sportcastle@aba', currency: 'KHR', amount: 389500 } });
    await expect(new BakongProvider(cfg, fetchImpl, () => now).checkTransaction('SC1-1', { raw: { md5: 'd'.repeat(32) } })).resolves.toMatchObject({ status: 'approved', amountCents: null, amountKhr: 389500 });
  });

  it('treats an expired token, a refusal or an unknown answer as a payment-service error', async () => {
    const md5 = { raw: { md5: 'e'.repeat(32) } };
    await expect(new BakongProvider(cfg, api({}, 401).fetchImpl, () => now).checkTransaction('SC1-1', md5)).rejects.toMatchObject({ code: 'payment_provider_error' });
    await expect(new BakongProvider(cfg, api({ responseCode: 9 }).fetchImpl, () => now).checkTransaction('SC1-1', md5)).rejects.toMatchObject({ code: 'payment_provider_error' });
  });

  it('says why a check failed (for the server log), without telling the customer', async () => {
    const md5 = { raw: { md5: 'f'.repeat(32) } };
    const reason = (p: Promise<unknown>) => p.then(() => null, (e: { details?: { reason?: string }; message: string }) => ({ reason: e.details?.reason, message: e.message }));
    expect(await reason(new BakongProvider(cfg, api({}, 403).fetchImpl, () => now).checkTransaction('SC1-1', md5))).toEqual({
      reason: 'Bakong answered HTTP 403 (expired token, or the API refused this server)',
      message: 'The payment service is not responding; please try again',
    });
    expect((await reason(new BakongProvider(cfg, api({ responseCode: 9, responseMessage: 'Bad md5' }).fetchImpl, () => now).checkTransaction('SC1-1', md5)))!.reason).toBe('Bakong answered responseCode 9: Bad md5');
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect((await reason(new BakongProvider(cfg, offline, () => now).checkTransaction('SC1-1', md5)))!.reason).toBe('Could not reach Bakong: fetch failed');
    const other = api({ responseCode: 0, data: { toAccountId: 'someone@aba', currency: 'USD', amount: 95 } }).fetchImpl;
    expect((await reason(new BakongProvider(cfg, other, () => now).checkTransaction('SC1-1', md5)))!.reason).toBe('Paid to someone@aba, not the shop account');
  });

  it('does not call Bakong for an attempt that never got a QR', async () => {
    const { calls, fetchImpl } = api({});
    await expect(new BakongProvider(cfg, fetchImpl, () => now).checkTransaction('SC1-1', { raw: null })).resolves.toMatchObject({ status: 'pending' });
    expect(calls).toHaveLength(0);
  });

  it('turns invalid shop settings into a clear error instead of a broken QR', async () => {
    const provider = new BakongProvider({ ...cfg, merchantName: 'A shop name much too long for KHQR' }, api({}).fetchImpl, () => now);
    await expect(provider.createTransaction(input)).rejects.toMatchObject({ code: 'payment_provider_error', message: expect.stringContaining('Bakong settings') });
  });
});

describe('createPaymentProvider with Bakong', () => {
  it('uses Bakong when it is configured and PayWay is not', () => {
    expect(createPaymentProvider(testConfig({ bakong: cfg }))).toBeInstanceOf(BakongProvider);
  });

  it('prefers PayWay when both are configured', () => {
    expect(createPaymentProvider(testConfig({ bakong: cfg, paywayMerchantId: 'm', paywayApiKey: 'k' })).name).toBe('payway');
  });
});
