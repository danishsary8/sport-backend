import { describe, expect, it } from 'vitest';
import { buildKhqr, crc16, khqrAmount, KhqrInputError } from '../../src/modules/payments/bakong/khqr.js';

const createdAt = new Date(1795741200000);

/** Produced by the National Bank of Cambodia's bakong-khqr SDK (1.0.20, generateIndividual) with the clock fixed at createdAt. */
const SDK_VECTORS = [
  {
    input: { accountId: 'sportcastle@aba', merchantName: 'Sport Castle', merchantCity: 'Phnom Penh', amountCents: 9500, billNumber: 'SC2611ABCDE-1', storeLabel: 'Sport Castle', minutes: 30 },
    qr: '00020101021229190015sportcastle@aba5204599953038405402955802KH5912Sport Castle6010Phnom Penh62330113SC2611ABCDE-10312Sport Castle993400131795741200000011317957430000006304BD67',
    md5: '00e081d88694a74fb009742fbd690663',
  },
  {
    input: { accountId: 'sportcastle@aba', merchantName: 'Sport Castle', merchantCity: 'Phnom Penh', amountCents: 1250, billNumber: 'SC2611ABCDE-2', minutes: 30 },
    qr: '00020101021229190015sportcastle@aba520459995303840540512.505802KH5912Sport Castle6010Phnom Penh62170113SC2611ABCDE-2993400131795741200000011317957430000006304A8E7',
    md5: 'b3c6bf86f0366abe15c396740dc1dd8a',
  },
  {
    input: { accountId: 'john_smith@devb', merchantName: 'John Smith', merchantCity: 'Siem Reap', amountCents: 1, billNumber: 'T1-1', minutes: 5 },
    qr: '00020101021229190015john_smith@devb52045999530384054040.015802KH5910John Smith6009Siem Reap62080104T1-1993400131795741200000011317957415000006304C0CC',
    md5: '3eeedbe30f22ae1eb2677b8f9b8e6db8',
  },
];

describe('buildKhqr', () => {
  it.each(SDK_VECTORS)('matches the official SDK for $input.billNumber', ({ input, qr, md5 }) => {
    const { minutes, ...rest } = input;
    const out = buildKhqr({ ...rest, currency: 'USD', createdAt, expiresAt: new Date(createdAt.getTime() + minutes * 60_000) });
    expect(out.qr).toBe(qr);
    expect(out.md5).toBe(md5);
  });

  it('refuses values that would make an invalid QR', () => {
    const base = { accountId: 'shop@aba', merchantName: 'Shop', merchantCity: 'Phnom Penh', amountCents: 100, currency: 'USD' as const, billNumber: 'T1', createdAt, expiresAt: new Date(createdAt.getTime() + 60_000) };
    expect(() => buildKhqr({ ...base, merchantName: 'A name that is far too long for a QR' })).toThrow(KhqrInputError);
    expect(() => buildKhqr({ ...base, merchantName: 'ស្ប៉ត' })).toThrow(KhqrInputError);
    expect(() => buildKhqr({ ...base, amountCents: 0 })).toThrow(KhqrInputError);
    expect(() => buildKhqr({ ...base, expiresAt: createdAt })).toThrow(KhqrInputError);
  });
});

describe('khqr helpers', () => {
  it('writes amounts like the SDK', () => {
    expect(khqrAmount(9500, 'USD')).toBe('95');
    expect(khqrAmount(1250, 'USD')).toBe('12.50');
    expect(khqrAmount(1, 'USD')).toBe('0.01');
  });

  it('computes CRC-16/CCITT-FALSE', () => {
    expect(crc16('123456789')).toBe('29B1');
  });
});
