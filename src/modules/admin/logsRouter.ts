import { count, desc, eq, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { notificationOutbox, paymentWebhookEvents } from '../../db/schema/index.js';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';

const paging = {
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
};

/** 'dara@example.com' → 'd***@example.com'; 'ops' stays. */
export function maskRecipient(recipient: string): string {
  const at = recipient.indexOf('@');
  return at > 0 ? `${recipient[0]}***${recipient.slice(at)}` : recipient;
}

export function adminLogsRouter(ctx: AppContext): Router {
  const router = Router();
  const { db } = ctx.database;
  const admin = [...ctx.member, requireRole('admin')];
  const noStore = (_req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  };

  router.get(
    '/admin/payments/webhooks',
    noStore,
    ...admin,
    validate({ query: z.object({ status: z.enum(['received', 'processed', 'ignored', 'rejected', 'failed']).optional(), ...paging }) }),
    async (req, res) => {
      const q = req.query as unknown as { status?: 'received' | 'processed' | 'ignored' | 'rejected' | 'failed'; page: number; pageSize: number };
      const where = q.status ? eq(paymentWebhookEvents.processingStatus, q.status) : sql`true`;
      const [total] = await db.select({ n: count() }).from(paymentWebhookEvents).where(where);
      const rows = await db.select().from(paymentWebhookEvents).where(where).orderBy(desc(paymentWebhookEvents.id)).limit(q.pageSize).offset((q.page - 1) * q.pageSize);
      res.json({
        events: rows.map((e) => ({ ...e, receivedAt: e.receivedAt.toISOString(), processedAt: e.processedAt?.toISOString() ?? null })),
        total: total?.n ?? 0,
      });
    },
  );

  router.get(
    '/admin/notifications',
    noStore,
    ...admin,
    validate({ query: z.object({ status: z.enum(['pending', 'sent', 'failed', 'skipped']).optional(), ...paging }) }),
    async (req, res) => {
      const q = req.query as unknown as { status?: 'pending' | 'sent' | 'failed' | 'skipped'; page: number; pageSize: number };
      const where = q.status ? eq(notificationOutbox.status, q.status) : sql`true`;
      const [total] = await db.select({ n: count() }).from(notificationOutbox).where(where);
      const rows = await db
        .select({
          id: notificationOutbox.id,
          channel: notificationOutbox.channel,
          recipient: notificationOutbox.recipient,
          template: notificationOutbox.template,
          status: notificationOutbox.status,
          attempts: notificationOutbox.attempts,
          lastError: notificationOutbox.lastError,
          createdAt: notificationOutbox.createdAt,
          sentAt: notificationOutbox.sentAt,
          nextAttemptAt: notificationOutbox.nextAttemptAt,
        })
        .from(notificationOutbox)
        .where(where)
        .orderBy(desc(notificationOutbox.id))
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize);
      res.json({
        notifications: rows.map((n) => ({
          ...n,
          recipient: maskRecipient(n.recipient),
          createdAt: n.createdAt.toISOString(),
          sentAt: n.sentAt?.toISOString() ?? null,
          nextAttemptAt: n.nextAttemptAt.toISOString(),
        })),
        total: total?.n ?? 0,
      });
    },
  );

  /** Sends one message straight away (not through the outbox) to prove a channel works. */
  router.post('/admin/notifications/test', noStore, ...admin, validate({ body: z.object({ channel: z.enum(['telegram', 'email']) }) }), async (req, res) => {
    const channel = (req.body as { channel: 'telegram' | 'email' }).channel;
    const notifier = ctx.notifiers[channel];
    if (!notifier.configured) {
      res.json({ sent: false, error: 'not configured' });
      return;
    }
    const to = channel === 'telegram' ? 'ops' : req.user!.email;
    if (!to) {
      res.json({ sent: false, error: 'your account has no email address' });
      return;
    }
    try {
      await notifier.send({ channel, to, subject: 'Sport Castle test message', text: `✅ Test message from the Sport Castle API (${new Date().toISOString()}).` });
      res.json({ sent: true });
    } catch (error) {
      res.json({ sent: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
    }
  });

  return router;
}
