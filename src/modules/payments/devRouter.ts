import { Router } from 'express';
import type { AppContext } from '../../context.js';
import { applyProviderResult } from './confirm.js';
import { FakePaymentProvider } from './fake.js';
import { TRAN_ID_PATTERN } from './provider.js';
import { escapeHtml } from '../notifications/templates.js';

/** Test-payment helpers. Mounted only outside production and only with the fake provider. */
export function devPaymentsRouter(ctx: AppContext): Router | null {
  if (ctx.config.nodeEnv === 'production' || !(ctx.payments instanceof FakePaymentProvider)) return null;
  const fake = ctx.payments;
  const router = Router();

  router.post('/dev/payments/:tranId/approve', async (req, res) => {
    const tranId = String(req.params.tranId);
    if (!TRAN_ID_PATTERN.test(tranId)) {
      res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
      return;
    }
    fake.approve(tranId);
    const check = await fake.checkTransaction(tranId);
    const result = await applyProviderResult({ db: ctx.database.db, now: () => new Date() }, tranId, check, 'dev');
    if (req.query.redirect === '1') {
      res.redirect(303, ctx.config.paywayContinueUrl ?? '/');
      return;
    }
    res.json({ result });
  });

  router.get('/dev/payments/:tranId/checkout', (req, res) => {
    const tranId = escapeHtml(String(req.params.tranId));
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
    res
      .type('html')
      .send(
        `<!doctype html><meta charset="utf-8"><title>Test card payment</title><body style="font-family:sans-serif;max-width:28rem;margin:3rem auto">` +
          `<h1>Test card payment</h1><p>Transaction ${tranId}. This page only exists in development.</p>` +
          `<form method="post" action="/v1/dev/payments/${tranId}/approve?redirect=1"><button type="submit">Approve test payment</button></form></body>`,
      );
  });

  return router;
}
