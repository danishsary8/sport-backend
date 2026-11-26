import { describe, expect, it } from 'vitest';
import { createPaymentProvider } from '../../src/modules/payments/provider.js';
import { FakePaymentProvider } from '../../src/modules/payments/fake.js';
import { testConfig } from '../helpers/testConfig.js';

describe('createPaymentProvider', () => {
  it('uses the fake provider outside production', () => {
    expect(createPaymentProvider(testConfig())).toBeInstanceOf(FakePaymentProvider);
  });

  it('never uses the fake provider in production without PayWay keys', async () => {
    const provider = createPaymentProvider(testConfig({ nodeEnv: 'production', paymentsCashOnly: true }));
    expect(provider).not.toBeInstanceOf(FakePaymentProvider);
    await expect(
      provider.createTransaction({
        tranId: 'SC1-1',
        method: 'aba_khqr',
        amountCents: 100,
        expiresAt: new Date(),
        customer: { firstName: 'A', lastName: 'B', phone: '+85512345678', email: null },
        items: [],
      }),
    ).rejects.toMatchObject({ code: 'payments_unavailable', status: 503 });
  });
});
