export interface OutgoingMessage {
  channel: 'telegram' | 'email';
  /** 'ops' for the shop's Telegram chat, or an email address. */
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Notifier {
  readonly channel: 'telegram' | 'email';
  readonly configured: boolean;
  /** Throws when the message could not be delivered. */
  send(message: OutgoingMessage): Promise<void>;
}

/** Records messages instead of sending them (tests, and local runs without credentials). */
export class FakeNotifier implements Notifier {
  readonly sent: OutgoingMessage[] = [];
  private failures = 0;

  constructor(
    readonly channel: 'telegram' | 'email',
    readonly configured = true,
  ) {}

  failNext(n: number): void {
    this.failures += n;
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('fake send failure');
    }
    this.sent.push(message);
  }
}

export async function postJson(fetchImpl: typeof fetch, url: string, body: unknown, headers: Record<string, string> = {}): Promise<void> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
