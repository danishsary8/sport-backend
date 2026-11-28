import { AppError } from '../../../lib/errors.js';
import type { PaymentMethod } from '../../../db/schema/index.js';
import type { CreateTransactionInput, PaymentInstructions, PaymentProvider, PaymentRef, TransactionCheck, WebhookVerification } from '../provider.js';
import { buildKhqr, KhqrInputError } from './khqr.js';

/**
 * Bakong (National Bank of Cambodia) KHQR: the shop makes the QR itself and asks Bakong's Open API whether
 * it was paid, by the QR's md5. Any Cambodian banking app can pay it. There is no webhook and no card payment.
 *
 * VERIFY AGAINST BAKONG: the check endpoint, its answer shape and the response codes below follow the
 * Bakong Open API documentation (api-bakong.nbc.gov.kh). Confirm them with one real $0.01 payment
 * before taking orders (docs/BAKONG-SETUP.md).
 */
export interface BakongConfig {
  /** Bakong Open API token (from api-bakong.nbc.gov.kh; it expires and must be renewed). */
  token: string;
  /** The shop's Bakong account that receives the money, e.g. "sportcastle@aba". */
  accountId: string;
  merchantName: string;
  merchantCity: string;
  /** https://api-bakong.nbc.gov.kh, or a relay in Cambodia if the API refuses requests from abroad. */
  apiUrl: string;
}

export const BAKONG_CHECK_PATH = '/v1/check_transaction_by_md5';
/** responseCode 0: found (paid). 1: no such transaction yet (not paid). Anything else: an error. */
const FOUND = 0;
const NOT_FOUND = 1;

/** The customer sees a generic message; `reason` (in details) says what went wrong, for the server log. */
const providerError = (reason: string) => new AppError('payment_provider_error', 502, 'The payment service is not responding; please try again', { reason });

interface CheckAnswer {
  responseCode?: unknown;
  responseMessage?: unknown;
  errorCode?: unknown;
  data?: { hash?: unknown; toAccountId?: unknown; currency?: unknown; amount?: unknown } | null;
}

function md5Of(ref: PaymentRef | undefined): string | null {
  const raw = ref?.raw as { md5?: unknown } | null | undefined;
  return typeof raw?.md5 === 'string' && /^[a-f0-9]{32}$/.test(raw.md5) ? raw.md5 : null;
}

export class BakongProvider implements PaymentProvider {
  readonly name = 'bakong' as const;
  readonly methods: readonly PaymentMethod[] = ['aba_khqr'];

  constructor(
    private readonly cfg: BakongConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createTransaction(input: CreateTransactionInput): Promise<{ instructions: PaymentInstructions; raw: unknown }> {
    if (input.method !== 'aba_khqr') throw new AppError('payment_method_unavailable', 400, 'That payment method is not available for this order');
    const createdAt = this.now();
    // Apps refuse an expired QR, so the hold's end is also the QR's end (at least 3 minutes, for a slow payer).
    const expiresAt = new Date(Math.max(input.expiresAt.getTime(), createdAt.getTime() + 3 * 60_000));
    let khqr;
    try {
      khqr = buildKhqr({
        accountId: this.cfg.accountId,
        merchantName: this.cfg.merchantName,
        merchantCity: this.cfg.merchantCity,
        amountCents: input.amountCents,
        currency: 'USD',
        billNumber: input.tranId,
        storeLabel: this.cfg.merchantName,
        createdAt,
        expiresAt,
      });
    } catch (error) {
      if (error instanceof KhqrInputError) throw new AppError('payment_provider_error', 502, `Bakong settings are invalid: ${error.message}`);
      throw error;
    }
    // The md5 is stored with the payment (payments.raw) so checkTransaction can find the payment at Bakong.
    return { instructions: { kind: 'qr', qrString: khqr.qr, deeplink: null, expiresAt: expiresAt.toISOString() }, raw: { md5: khqr.md5 } };
  }

  async checkTransaction(_tranId: string, ref?: PaymentRef): Promise<TransactionCheck> {
    const md5 = md5Of(ref);
    // No md5 means no QR was ever made for this attempt (it failed before Bakong): nothing can have been paid.
    if (!md5) return { status: 'pending', amountCents: null, raw: null };

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.apiUrl}${BAKONG_CHECK_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${this.cfg.token}` },
        body: JSON.stringify({ md5 }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw providerError(`Could not reach Bakong: ${error instanceof Error ? error.message : 'network error'}`);
    }
    // 401/403: the token expired or the API refused this server (it may only answer from Cambodia).
    if (!res.ok) throw providerError(`Bakong answered HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' (expired token, or the API refused this server)' : ''}`);
    let body: CheckAnswer;
    try {
      body = (await res.json()) as CheckAnswer;
    } catch {
      throw providerError('Bakong answered something that is not JSON');
    }

    const code = Number(body.responseCode);
    if (code === NOT_FOUND) return { status: 'pending', amountCents: null, raw: { responseCode: code } };
    if (code !== FOUND || !body.data) throw providerError(`Bakong answered responseCode ${String(body.responseCode)}${typeof body.responseMessage === 'string' && body.responseMessage ? `: ${body.responseMessage}` : ''}`);

    const { toAccountId, currency, amount, hash } = body.data;
    const raw = { responseCode: code, hash: typeof hash === 'string' ? hash : null, toAccountId, currency, amount };
    // The md5 belongs to a QR this shop made, so a different receiving account means something is badly wrong:
    // never confirm it; the order gets the "payment unverified" alert instead.
    if (typeof toAccountId === 'string' && toAccountId.toLowerCase() !== this.cfg.accountId.toLowerCase()) throw providerError(`Paid to ${toAccountId}, not the shop account`);
    const dollars = Number(amount);
    const usd = currency === undefined || currency === null || String(currency).toUpperCase() === 'USD';
    // Only a USD amount can be compared with the order total; anything else is confirmed as "amount unknown",
    // which flags the order for a staff check instead of confirming it.
    return { status: 'approved', amountCents: usd && Number.isFinite(dollars) ? Math.round(dollars * 100) : null, raw };
  }

  /** A KHQR cannot be withdrawn; it stops working at its expiry time, and a late payment is flagged by confirmation. */
  async cancelTransaction(): Promise<void> {}

  /** Bakong sends no webhooks: payments are found by polling. */
  verifyWebhook(): WebhookVerification {
    return { valid: false, tranId: null, eventId: 'bakong:no-webhooks', reason: 'Bakong does not send webhooks', claimedStatus: null, payload: {} };
  }
}
