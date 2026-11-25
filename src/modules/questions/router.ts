import { and, count, desc, eq, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { productQuestions, products } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { PUBLIC_CACHE } from '../catalog/router.js';
import { pick } from '../catalog/i18n.js';
import { enqueueMessage } from '../notifications/outbox.js';

const slugParam = z.object({ slug: z.string().trim().min(1).max(200) });

export function questionsRouter(ctx: AppContext): Router {
  const router = Router();
  const { db } = ctx.database;
  const staff = [...ctx.member, requireRole('staff', 'admin')];

  async function productBySlug(slug: string) {
    const [p] = await db.select({ id: products.id, name: products.nameI18n }).from(products).where(and(eq(products.slug, slug), eq(products.status, 'active')));
    if (!p) throw new AppError('not_found', 404, 'Product not found');
    return p;
  }

  router.get('/catalog/products/:slug/questions', validate({ params: slugParam }), async (req, res) => {
    const product = await productBySlug(String(req.params.slug));
    const rows = await db
      .select({
        id: productQuestions.id,
        authorName: productQuestions.authorName,
        question: productQuestions.question,
        answer: productQuestions.answer,
        answeredAt: productQuestions.answeredAt,
        createdAt: productQuestions.createdAt,
      })
      .from(productQuestions)
      .where(and(eq(productQuestions.productId, product.id), eq(productQuestions.status, 'published')))
      .orderBy(desc(productQuestions.createdAt))
      .limit(50);
    res.setHeader('Cache-Control', PUBLIC_CACHE);
    res.json({ questions: rows.map((r) => ({ ...r, answeredAt: r.answeredAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() })) });
  });

  router.post(
    '/catalog/products/:slug/questions',
    ctx.routeLimit('questions', 5),
    ...ctx.guestOrMember,
    validate({ params: slugParam, body: z.object({ authorName: z.string().trim().min(1).max(60), question: z.string().trim().min(5).max(500) }) }),
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const product = await productBySlug(String(req.params.slug));
      const { authorName, question } = req.body as { authorName: string; question: string };
      await db.transaction(async (tx) => {
        await tx.insert(productQuestions).values({ productId: product.id, userId: req.user?.id ?? null, authorName, question });
        await enqueueMessage(tx, 'telegram', 'ops', 'question_received', {
          number: '', status: '', totalCents: 0, totalKhr: 0, contactName: authorName, contactPhone: '', contactChannel: '', fulfillment: '', items: [],
          question: { productName: pick(product.name, 'en') ?? String(req.params.slug), authorName, text: question },
        });
      });
      res.status(201).json({ status: 'pending' });
    },
  );

  router.get(
    '/admin/questions',
    ...staff,
    validate({
      query: z.object({
        status: z.enum(['pending', 'published', 'hidden']).optional(),
        page: z.coerce.number().int().min(1).max(10_000).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      }),
    }),
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const q = req.query as unknown as { status?: 'pending' | 'published' | 'hidden'; page: number; pageSize: number };
      const where = q.status ? eq(productQuestions.status, q.status) : sql`true`;
      const [total] = await db.select({ n: count() }).from(productQuestions).where(where);
      const rows = await db
        .select({ q: productQuestions, productSlug: products.slug, productName: products.nameI18n })
        .from(productQuestions)
        .innerJoin(products, eq(products.id, productQuestions.productId))
        .where(where)
        .orderBy(desc(productQuestions.createdAt))
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize);
      res.json({
        questions: rows.map(({ q: r, productSlug, productName }) => ({
          id: r.id,
          productSlug,
          productName: pick(productName, 'en'),
          authorName: r.authorName,
          question: r.question,
          answer: r.answer,
          status: r.status,
          fromMember: r.userId !== null,
          answeredAt: r.answeredAt?.toISOString() ?? null,
          createdAt: r.createdAt.toISOString(),
        })),
        total: total?.n ?? 0,
      });
    },
  );

  router.patch(
    '/admin/questions/:id',
    ...staff,
    validate({
      params: z.object({ id: z.string().uuid() }),
      body: z
        .object({ answer: z.string().trim().min(1).max(2000).optional(), status: z.enum(['pending', 'published', 'hidden']).optional() })
        .refine((v) => v.answer !== undefined || v.status !== undefined, { message: 'Nothing to update' }),
    }),
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const { answer, status } = req.body as { answer?: string; status?: 'pending' | 'published' | 'hidden' };
      const [current] = await db.select().from(productQuestions).where(eq(productQuestions.id, String(req.params.id)));
      if (!current) throw new AppError('not_found', 404, 'Question not found');
      if (status === 'published' && !(answer ?? current.answer)) throw new AppError('answer_required', 400, 'Answer the question before publishing it');
      const [updated] = await db
        .update(productQuestions)
        .set({
          ...(answer !== undefined ? { answer, answeredBy: req.user!.id, answeredAt: sql`now()` } : {}),
          ...(status ? { status } : {}),
        })
        .where(eq(productQuestions.id, current.id))
        .returning();
      res.json({ question: { id: updated!.id, status: updated!.status, answer: updated!.answer, answeredAt: updated!.answeredAt?.toISOString() ?? null } });
    },
  );

  return router;
}
