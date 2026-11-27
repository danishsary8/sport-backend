import { AppError } from '../../../lib/errors.js';
import type { PaymentMethod } from '../../../db/schema/index.js';
import { pickFields, TRAN_ID_PATTERN, type CreateTransactionInput, type PaymentInstructions, type PaymentProvider, type TransactionCheck, type WebhookVerification } from '../provider.js';
import { paywayHash, safeEqualB64 } from './hash.js';
import { CHECK_FIELDS, CHECK_NOT_FOUND_CODES, CHECK_SUCCESS_CODES, PAYWAY_PATHS, PUSHBACK_FIELDS, PURCHASE_FIELDS, PUSHBACK_HASH_FIELDS, PUSHBACK_SUCCESS, QR_FIELDS, QR_IMAGE_TEMPLATE, STATUS_MAP } from './mapping.js';

export interface PayWayConfig {
  merchantId: string;
  apiKey: string;
  baseUrl: string;
  returnUrl: string;
  continueUrl: string;
}

const providerError = () => new AppError('payment_provider_error', 502, 'The payment service is not responding; please try again');
const b64 = (value: string) => Buffer.from(value).toString('base64');
const dollars = (cents: number) => (cents / 100).toFixed(2);

/** YYYYMMDDHHmmss in UTC. */
function reqTime(now: Date): string {
  return now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function sign(fields: readonly string[], body: Record<string, string>, apiKey: string): Record<string, string> {
  return { ...body, hash: paywayHash(fields.map((f) => body[f] ?? ''), apiKey) };
}

/** ABA PayWay: KHQR and hosted card checkout, signed server-to-server with the merchant API key. */
export class PayWayProvider implements PaymentProvider {
  readonly name = 'payway' as const;
  readonly methods: readonly PaymentMethod[] = ['aba_khqr', 'card'];

  constructor(
    private readonly cfg: PayWayConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async post(path: string, body: Record<string, string>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw providerError();
    }
    if (!res.ok) throw providerError();
    try {
      return (await res.json()) as Record<string, unknown>;
    } catch {
      throw providerError();
    }
  }

  private lifetimeMinutes(expiresAt: Date): string {
    return String(Math.max(3, Math.ceil((expiresAt.getTime() - this.now().getTime()) / 60_000)));
  }

  async createTransaction(input: CreateTransactionInput): Promise<{ instructions: PaymentInstructions; raw: unknown }> {
    const common = {
      req_time: reqTime(this.now()),
      merchant_id: this.cfg.merchantId,
      tran_id: input.tranId,
      amount: dollars(input.amountCents),
      items: b64(JSON.stringify(input.items.map((i) => ({ name: i.name, quantity: i.qty, price: dollars(i.priceCents) })))),
      email: input.customer.email ?? '',
      phone: input.customer.phone,
      currency: 'USD',
      return_deeplink: '',
      custom_fields: '',
      return_params: '',
      payout: '',
      lifetime: this.lifetimeMinutes(input.expiresAt),
    };
    const expiresAt = input.expiresAt.toISOString();

    if (input.method === 'card') {
      const fields = sign(
        PURCHASE_FIELDS,
        {
          ...common,
          shipping: '',
          firstname: input.customer.firstName,
          lastname: input.customer.lastName,
          type: 'purchase',
          payment_option: 'cards',
          return_url: b64(this.cfg.returnUrl),
          cancel_url: '',
          continue_success_url: this.cfg.continueUrl,
          additional_params: '',
          google_pay_token: '',
          skip_success_page: '',
        },
        this.cfg.apiKey,
      );
      return { instructions: { kind: 'redirect', method: 'POST', url: `${this.cfg.baseUrl}${PAYWAY_PATHS.purchase}`, fields, expiresAt }, raw: null };
    }

    const body = sign(
      QR_FIELDS,
      {
        ...common,
        first_name: input.customer.firstName,
        last_name: input.customer.lastName,
        purchase_type: 'purchase',
        payment_option: 'abapay_khqr',
        callback_url: b64(this.cfg.returnUrl),
        qr_image_template: QR_IMAGE_TEMPLATE,
      },
      this.cfg.apiKey,
    );
    const res = await this.post(PAYWAY_PATHS.qr, body);
    const status = res.status as { code?: unknown } | undefined;
    const qrString = typeof res.qrString === 'string' ? res.qrString : null;
    if (String(status?.code ?? '') !== '0' || !qrString) throw providerError();
    const deeplink = typeof res.abapay_deeplink === 'string' ? res.abapay_deeplink : null;
    return { instructions: { kind: 'qr', qrString, deeplink, expiresAt }, raw: { status, hasQr: true } };
  }

  async checkTransaction(tranId: string): Promise<TransactionCheck> {
    const body = sign(CHECK_FIELDS, { req_time: reqTime(this.now()), merchant_id: this.cfg.merchantId, tran_id: tranId }, this.cfg.apiKey);
    const res = await this.post(PAYWAY_PATHS.check, body);
    const code = String((res.status as { code?: unknown } | undefined)?.code ?? '');
    if (CHECK_NOT_FOUND_CODES.includes(code)) return { status: 'pending', amountCents: null, raw: res };
    // Anything but success (wrong hash, rate limit, changed API) is a provider error, so the grace period and the
    // "payment unverified" alert apply instead of the order quietly expiring as unpaid.
    if (!CHECK_SUCCESS_CODES.includes(code)) throw providerError();
    const data = (res.data ?? {}) as { payment_status?: unknown; total_amount?: unknown };
    const remote = String(data.payment_status ?? '').toUpperCase();
    // An unknown transaction (e.g. a card checkout the shopper never opened) or a status this code doesn't
    // know yet is "not paid": the order may expire normally. Only APPROVED ever confirms an order.
    const status = STATUS_MAP[remote] ?? 'pending';
    const amount = Number(data.total_amount);
    return { status, amountCents: Number.isFinite(amount) ? Math.round(amount * 100) : null, raw: res };
  }

  async cancelTransaction(tranId: string): Promise<void> {
    const body = sign(CHECK_FIELDS, { req_time: reqTime(this.now()), merchant_id: this.cfg.merchantId, tran_id: tranId }, this.cfg.apiKey);
    await this.post(PAYWAY_PATHS.close, body);
  }

  verifyWebhook(rawBody: Buffer, _headers: Record<string, string | undefined> = {}): WebhookVerification {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      return { valid: false, tranId: null, eventId: 'invalid', reason: 'malformed', claimedStatus: null, payload: {} };
    }
    const payload = pickFields(body, PUSHBACK_FIELDS);
    const tranId = typeof body.tran_id === 'string' && TRAN_ID_PATTERN.test(body.tran_id) ? body.tran_id : null;
    const status = body.status === undefined || body.status === null ? '' : String(body.status);
    const apv = body.apv === undefined || body.apv === null ? '' : String(body.apv);
    const eventId = `${tranId ?? 'invalid'}:${status}:${apv}`;
    if (!tranId || status.length > 20 || apv.length > 40) return { valid: false, tranId: null, eventId: eventId.slice(0, 80), reason: 'malformed', claimedStatus: null, payload };
    if (typeof body.hash === 'string') {
      const values: Record<string, string> = { tran_id: tranId, apv, status };
      const expected = paywayHash(PUSHBACK_HASH_FIELDS.map((f) => values[f] ?? ''), this.cfg.apiKey);
      if (!safeEqualB64(expected, body.hash)) return { valid: false, tranId, eventId, reason: 'signature_mismatch', claimedStatus: null, payload };
    }
    return { valid: true, tranId, eventId, claimedStatus: status === PUSHBACK_SUCCESS ? 'approved' : null, payload };
  }
}
