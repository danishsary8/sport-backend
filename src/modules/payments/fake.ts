import type { PaymentMethod } from '../../db/schema/index.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../lib/errors.js';
import { pickFields, TRAN_ID_PATTERN, type CreateTransactionInput, type PaymentInstructions, type PaymentProvider, type ProviderStatus, type TransactionCheck, type WebhookVerification } from './provider.js';

const FAKE_SECRET = 'fake-payment-provider-dev-secret';

/** In-memory stand-in for PayWay: tests and local development without merchant credentials. */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'fake' as const;
  readonly methods: readonly PaymentMethod[] = ['aba_khqr', 'card', 'acleda', 'wing'];
  readonly created: CreateTransactionInput[] = [];
  readonly cancelled: string[] = [];
  checkCalls = 0;
  private failingChecks = false;
  private readonly state = new Map<string, { status: ProviderStatus; amountCents: number }>();
  private failCreates = 0;
  private readonly publicApiUrl: string;

  constructor(opts: { publicApiUrl?: string } = {}) {
    this.publicApiUrl = (opts.publicApiUrl ?? 'http://localhost:3000').replace(/\/+$/, '');
  }

  /** Every checkTransaction throws payment_provider_error (an outage) until switched off. */
  failAllChecks(on: boolean): void {
    this.failingChecks = on;
  }

  failNextCreate(): void {
    this.failCreates += 1;
  }

  approve(tranId: string, amountCents?: number): void {
    const current = this.state.get(tranId);
    this.state.set(tranId, { status: 'approved', amountCents: amountCents ?? current?.amountCents ?? 0 });
  }

  decline(tranId: string): void {
    const current = this.state.get(tranId);
    this.state.set(tranId, { status: 'declined', amountCents: current?.amountCents ?? 0 });
  }

  sign(body: string): string {
    return createHmac('sha512', FAKE_SECRET).update(body).digest('base64');
  }

  async createTransaction(input: CreateTransactionInput): Promise<{ instructions: PaymentInstructions; raw: unknown }> {
    if (this.failCreates > 0) {
      this.failCreates -= 1;
      throw new AppError('payment_provider_error', 502, 'The payment service is not responding; please try again');
    }
    this.created.push(input);
    this.state.set(input.tranId, { status: 'pending', amountCents: input.amountCents });
    const expiresAt = input.expiresAt.toISOString();
    const instructions: PaymentInstructions =
      input.method === 'card'
        ? { kind: 'redirect', method: 'GET', url: `${this.publicApiUrl}/v1/dev/payments/${input.tranId}/checkout`, fields: {}, expiresAt }
        : { kind: 'qr', qrString: `FAKE-KHQR|${input.tranId}|${(input.amountCents / 100).toFixed(2)}|USD`, deeplink: null, expiresAt };
    return { instructions, raw: { fake: true } };
  }

  async checkTransaction(tranId: string): Promise<TransactionCheck> {
    this.checkCalls += 1;
    if (this.failingChecks) throw new AppError('payment_provider_error', 502, 'The payment service is not responding; please try again');
    const s = this.state.get(tranId);
    if (!s) return { status: 'pending', amountCents: null, raw: { fake: true, known: false } };
    return { status: s.status, amountCents: s.amountCents, raw: { fake: true } };
  }

  async cancelTransaction(tranId: string): Promise<void> {
    this.cancelled.push(tranId);
    const s = this.state.get(tranId);
    if (s && s.status === 'pending') this.state.set(tranId, { ...s, status: 'cancelled' });
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): WebhookVerification {
    const signature = headers['x-fake-signature'] ?? '';
    const expected = Buffer.from(this.sign(rawBody.toString('utf8')));
    const given = Buffer.from(signature);
    let body: { tran_id?: unknown; status?: unknown; apv?: unknown } = {};
    try {
      body = JSON.parse(rawBody.toString('utf8')) as typeof body;
    } catch {
      // invalid below
    }
    const tranId = typeof body.tran_id === 'string' && TRAN_ID_PATTERN.test(body.tran_id) ? body.tran_id : null;
    const claimed = typeof body.status === 'string' ? (body.status as ProviderStatus) : null;
    const eventId = `${tranId ?? 'invalid'}:${claimed ?? ''}${typeof body.apv === 'string' ? `:${body.apv}` : ''}`.slice(0, 80);
    const short = (v: unknown, n: number) => v === undefined || (typeof v === 'string' && v.length <= n);
    const valid = tranId !== null && short(body.status, 20) && short(body.apv, 40) && expected.length === given.length && timingSafeEqual(expected, given);
    return { valid, tranId, eventId, claimedStatus: claimed, reason: valid ? undefined : 'signature_mismatch', payload: pickFields(body, ['tran_id', 'status', 'apv']) };
  }
}
