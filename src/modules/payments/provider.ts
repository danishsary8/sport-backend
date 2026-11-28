import { AppError } from '../../lib/errors.js';
import type { Config } from '../../config/env.js';
import type { PaymentMethod } from '../../db/schema/index.js';
import { FakePaymentProvider } from './fake.js';
import { BakongProvider } from './bakong/client.js';
import { PayWayProvider } from './payway/client.js';

export type ProviderStatus = 'pending' | 'approved' | 'declined' | 'cancelled' | 'refunded' | 'expired';

export type PaymentInstructions =
  | { kind: 'qr'; qrString: string; deeplink: string | null; expiresAt: string }
  | { kind: 'redirect'; url: string; method: 'GET' | 'POST'; fields: Record<string, string>; expiresAt: string }
  | { kind: 'none' };

export interface CreateTransactionInput {
  tranId: string;
  method: PaymentMethod;
  amountCents: number;
  expiresAt: Date;
  customer: { firstName: string; lastName: string; phone: string; email: string | null };
  items: { name: string; qty: number; priceCents: number }[];
}

export interface TransactionCheck {
  status: ProviderStatus;
  /** What the provider says was paid; null when it doesn't say. */
  amountCents: number | null;
  /** When the provider reports the amount in riel instead: compared with the order's riel total. */
  amountKhr?: number | null;
  raw: unknown;
}

export interface WebhookVerification {
  valid: boolean;
  tranId: string | null;
  /** Stable id for idempotent storage of the delivery. */
  eventId: string;
  reason?: string;
  /** What the webhook claims; never trusted without checkTransaction. */
  claimedStatus: ProviderStatus | null;
  /** The known pushback fields only (what gets stored). */
  payload: Record<string, string>;
}

/** Keeps only the named string/number fields, each cut to 200 characters. */
export function pickFields(body: unknown, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!body || typeof body !== 'object') return out;
  for (const k of keys) {
    const v = (body as Record<string, unknown>)[k];
    if (typeof v === 'string' || typeof v === 'number') out[k] = String(v).slice(0, 200);
  }
  return out;
}

/** What the shop stored about an attempt when it was created (payments.raw), for providers that need it to look the payment up. */
export interface PaymentRef {
  raw: unknown;
}

/** A payment service: create a payment, ask its status, cancel it, recognise its webhooks. */
export interface PaymentProvider {
  readonly name: 'payway' | 'bakong' | 'fake';
  /** The payment methods this service can take (the shop's settings can switch some off). */
  readonly methods: readonly PaymentMethod[];
  createTransaction(input: CreateTransactionInput): Promise<{ instructions: PaymentInstructions; raw: unknown }>;
  checkTransaction(tranId: string, ref?: PaymentRef): Promise<TransactionCheck>;
  cancelTransaction(tranId: string): Promise<void>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): WebhookVerification;
}

/**
 * PayWay when its credentials are set, else Bakong KHQR when its settings are, else the local fake outside
 * production (production then refuses online payment: cash-only mode).
 */
export function createPaymentProvider(config: Config, fetchImpl: typeof fetch = fetch): PaymentProvider {
  if (config.paywayMerchantId && config.paywayApiKey) {
    return new PayWayProvider(
      {
        merchantId: config.paywayMerchantId,
        apiKey: config.paywayApiKey,
        baseUrl: config.paywayBaseUrl,
        returnUrl: config.paywayReturnUrl ?? `${config.publicApiUrl}/v1/webhooks/payway`,
        continueUrl: config.paywayContinueUrl ?? config.publicApiUrl,
      },
      fetchImpl,
    );
  }
  if (config.bakong) return new BakongProvider(config.bakong, fetchImpl);
  // Production never fakes payments: without PayWay keys (cash-only mode) every online payment is refused.
  if (config.nodeEnv === 'production') return new DisabledPaymentProvider();
  return new FakePaymentProvider({ publicApiUrl: config.publicApiUrl });
}

/** Stands in for PayWay when the shop runs cash-only: refuses every online payment. */
export class DisabledPaymentProvider implements PaymentProvider {
  readonly name = 'payway' as const;
  readonly methods: readonly PaymentMethod[] = [];
  private refuse(): never {
    throw new AppError('payments_unavailable', 503, 'Online payment is not available right now. Choose cash on pickup.');
  }
  async createTransaction(): Promise<never> {
    this.refuse();
  }
  async checkTransaction(): Promise<never> {
    this.refuse();
  }
  async cancelTransaction(): Promise<void> {}
  verifyWebhook(): WebhookVerification {
    return { valid: false, tranId: null, eventId: 'disabled', reason: 'online payments are disabled', claimedStatus: null, payload: {} };
  }
}

export const TRAN_ID_PATTERN = /^[A-Za-z0-9-]{1,20}$/;
