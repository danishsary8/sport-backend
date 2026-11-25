import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../../context.js';
import { requireRole } from '../../../middleware/auth.js';
import { validate } from '../../../middleware/validate.js';
import { createSystemHealth } from './service.js';
import {
  buildConnectionLogsCsv,
  buildConnectionLogsCsvFilename,
  DEFAULT_LATENCY_ALERT_THRESHOLD_MS,
  getRecentConnectionAttemptLogs,
  sanitizeLatencyThresholdMs,
} from './types.js';

/** Admin-only monitoring. The public probes stay at GET /health and GET /ready (no details). */
export function systemHealthRouter(ctx: AppContext): Router {
  const router = Router();
  const health = createSystemHealth(ctx.database.pool);
  const admin = [...ctx.member, requireRole('admin')];

  router.use('/admin/system-health', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/admin/system-health', ...admin, async (_req, res) => {
    const snapshot = await health.snapshot();
    res.status(snapshot.overallStatus === 'operational' ? 200 : 503).json(snapshot);
  });

  router.get(
    '/admin/system-health/metrics',
    ...admin,
    validate({ query: z.object({ limit: z.string().max(6).optional(), thresholdMs: z.string().max(6).optional(), probe: z.enum(['true', 'false', '1', '0']).optional() }) }),
    async (req, res) => {
      const q = req.query as { limit?: string; thresholdMs?: string; probe?: string };
      res.json(await health.metrics({ limit: q.limit, thresholdMs: q.thresholdMs, probe: q.probe !== 'false' && q.probe !== '0' }));
    },
  );

  router.get('/admin/system-health/logs.csv', ...admin, validate({ query: z.object({ thresholdMs: z.string().max(6).optional() }) }), async (req, res) => {
    const thresholdMs = sanitizeLatencyThresholdMs((req.query as { thresholdMs?: string }).thresholdMs, DEFAULT_LATENCY_ALERT_THRESHOLD_MS);
    const snapshot = await health.snapshot();
    const csv = buildConnectionLogsCsv(getRecentConnectionAttemptLogs(snapshot.recentChecks, 20), thresholdMs);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${buildConnectionLogsCsvFilename(new Date())}"`);
    res.send(`﻿${csv}`);
  });

  return router;
}
