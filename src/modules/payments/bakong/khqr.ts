import { createHash } from 'node:crypto';

/**
 * KHQR (Cambodia's EMVCo-based QR) for one payment: a dynamic "individual" KHQR with the amount, the
 * order's transaction id as the bill number and an expiry time.
 *
 * Written to match the National Bank of Cambodia's `bakong-khqr` SDK byte for byte (see
 * test/unit/bakongKhqr.test.ts, whose expected strings were produced by that SDK), without taking on
 * its dependencies. The md5 of the string is how Bakong's API finds the payment afterwards.
 */

export interface KhqrInput {
  /** Bakong account that receives the money, e.g. "sportcastle@aba". */
  accountId: string;
  /** Shown to the payer in their bank app (max 25 characters). */
  merchantName: string;
  /** Max 15 characters. */
  merchantCity: string;
  amountCents: number;
  currency: 'USD' | 'KHR';
  /** Reference shown in the payer's bank statement (max 25 characters): the transaction id. */
  billNumber: string;
  /** Optional label (max 25 characters), e.g. the shop's name. */
  storeLabel?: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface Khqr {
  qr: string;
  md5: string;
}

const TAG = {
  payloadFormat: '00',
  initiationMethod: '01',
  individualAccount: '29',
  accountId: '00',
  merchantCategory: '52',
  currency: '53',
  amount: '54',
  country: '58',
  merchantName: '59',
  merchantCity: '60',
  additionalData: '62',
  billNumber: '01',
  storeLabel: '03',
  timestamps: '99',
  createdAt: '00',
  expiresAt: '01',
  crc: '63',
} as const;

const CURRENCY_CODE = { USD: '840', KHR: '116' } as const;
const DYNAMIC_QR = '12';
const DEFAULT_MCC = '5999';

const LIMITS = { accountId: 32, merchantName: 25, merchantCity: 15, billNumber: 25, storeLabel: 25 } as const;

export class KhqrInputError extends Error {}

function check(name: keyof typeof LIMITS, value: string): string {
  // Lengths in the QR count characters; only printable ASCII keeps characters and bytes equal for every app.
  if (!/^[\x20-\x7E]+$/.test(value)) throw new KhqrInputError(`${name} must be plain ASCII text`);
  if (value.length > LIMITS[name]) throw new KhqrInputError(`${name} must be at most ${LIMITS[name]} characters`);
  return value;
}

function tlv(tag: string, value: string): string {
  if (value.length > 99) throw new KhqrInputError(`tag ${tag} is too long`);
  return `${tag}${String(value.length).padStart(2, '0')}${value}`;
}

/** The amount as the SDK writes it: dollars, with two decimals only when there are cents ("95", "12.50"); whole riel. */
export function khqrAmount(amountCents: number, currency: KhqrInput['currency']): string {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new KhqrInputError('amount must be a positive whole number of cents');
  if (currency === 'KHR') return String(amountCents / 100);
  return amountCents % 100 === 0 ? String(amountCents / 100) : (amountCents / 100).toFixed(2);
}

/** CRC-16/CCITT-FALSE (polynomial 0x1021, start 0xFFFF), as four upper-case hex digits. */
export function crc16(text: string): string {
  let crc = 0xffff;
  for (const byte of Buffer.from(text, 'utf8')) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export function buildKhqr(input: KhqrInput): Khqr {
  if (input.expiresAt.getTime() <= input.createdAt.getTime()) throw new KhqrInputError('the QR must expire after it is created');
  const additional = tlv(TAG.billNumber, check('billNumber', input.billNumber)) + (input.storeLabel ? tlv(TAG.storeLabel, check('storeLabel', input.storeLabel)) : '');
  const body =
    tlv(TAG.payloadFormat, '01') +
    tlv(TAG.initiationMethod, DYNAMIC_QR) +
    tlv(TAG.individualAccount, tlv(TAG.accountId, check('accountId', input.accountId))) +
    tlv(TAG.merchantCategory, DEFAULT_MCC) +
    tlv(TAG.currency, CURRENCY_CODE[input.currency]) +
    tlv(TAG.amount, khqrAmount(input.amountCents, input.currency)) +
    tlv(TAG.country, 'KH') +
    tlv(TAG.merchantName, check('merchantName', input.merchantName)) +
    tlv(TAG.merchantCity, check('merchantCity', input.merchantCity)) +
    tlv(TAG.additionalData, additional) +
    tlv(TAG.timestamps, tlv(TAG.createdAt, String(input.createdAt.getTime())) + tlv(TAG.expiresAt, String(input.expiresAt.getTime())));
  const withCrcTag = `${body}${TAG.crc}04`;
  const qr = withCrcTag + crc16(withCrcTag);
  return { qr, md5: createHash('md5').update(qr).digest('hex') };
}
