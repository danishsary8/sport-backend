import type { Config } from '../../config/env.js';
import type { PaymentMethod } from '../../db/schema/index.js';
import { FakePaymentProvider } from './fake.js';
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
}

/** A payment service: create a payment, ask its status, cancel it, recognise its webhooks. */
export interface PaymentProvider {
  readonly name: 'payway' | 'fake';
  createTransaction(input: CreateTransactionInput): Promise<{ instructions: PaymentInstructions; raw: unknown }>;
  checkTransaction(tranId: string): Promise<TransactionCheck>;
  cancelTransaction(tranId: string): Promise<void>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): WebhookVerification;
}

/** PayWay when credentials are configured, otherwise the local fake (production config refuses that case). */
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
  return new FakePaymentProvider({ publicApiUrl: config.publicApiUrl });
}

export const TRAN_ID_PATTERN = /^[A-Za-z0-9-]{1,20}$/;
