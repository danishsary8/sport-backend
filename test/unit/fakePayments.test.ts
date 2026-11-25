import { describe, expect, it } from 'vitest';
import { FakePaymentProvider } from '../../src/modules/payments/fake.js';

const input = {
  tranId: 'SC2611AAAAA-1',
  method: 'aba_khqr' as const,
  amountCents: 5250,
  expiresAt: new Date(Date.now() + 60_000),
  customer: { firstName: 'Sok', lastName: 'Dara', phone: '+85512345678', email: null },
  items: [],
};

describe('FakePaymentProvider', () => {
  it('creates a QR and follows approve/decline', async () => {
    const fake = new FakePaymentProvider();
    const { instructions } = await fake.createTransaction(input);
    expect(instructions.kind).toBe('qr');
    expect(await fake.checkTransaction(input.tranId)).toMatchObject({ status: 'pending' });
    fake.approve(input.tranId);
    expect(await fake.checkTransaction(input.tranId)).toMatchObject({ status: 'approved', amountCents: 5250 });
    fake.decline(input.tranId);
    expect((await fake.checkTransaction(input.tranId)).status).toBe('declined');
    expect(fake.checkCalls).toBe(3);
  });

  it('gives cards a redirect to the dev checkout page', async () => {
    const fake = new FakePaymentProvider({ publicApiUrl: 'http://localhost:3000' });
    const { instructions } = await fake.createTransaction({ ...input, method: 'card' });
    expect(instructions).toMatchObject({ kind: 'redirect', method: 'GET', url: `http://localhost:3000/v1/dev/payments/${input.tranId}/checkout` });
  });

  it('can be told to fail the next create', async () => {
    const fake = new FakePaymentProvider();
    fake.failNextCreate();
    await expect(fake.createTransaction(input)).rejects.toMatchObject({ code: 'payment_provider_error' });
    await expect(fake.createTransaction(input)).resolves.toBeDefined();
  });

  it('records cancellations', async () => {
    const fake = new FakePaymentProvider();
    await fake.createTransaction(input);
    await fake.cancelTransaction(input.tranId);
    expect(fake.cancelled).toEqual([input.tranId]);
    expect((await fake.checkTransaction(input.tranId)).status).toBe('cancelled');
  });

  it('verifies its own webhook signature', () => {
    const fake = new FakePaymentProvider();
    const body = JSON.stringify({ tran_id: input.tranId, status: 'approved' });
    expect(fake.verifyWebhook(Buffer.from(body), { 'x-fake-signature': fake.sign(body) })).toMatchObject({ valid: true, tranId: input.tranId, claimedStatus: 'approved' });
    expect(fake.verifyWebhook(Buffer.from(body), { 'x-fake-signature': 'nope' }).valid).toBe(false);
  });
});
