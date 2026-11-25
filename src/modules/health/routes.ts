import { Router } from 'express';
import { ApiError } from '../../lib/errors.js';

export interface HealthDeps {
  /** Resolves when the database answers; rejects otherwise. */
  checkDb: () => Promise<void>;
}

export function healthRoutes(deps: HealthDeps): Router {
  const router = Router();
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  router.get('/ready', async (_req, res, next) => {
    try {
      await deps.checkDb();
      res.json({ status: 'ready' });
    } catch {
      next(ApiError.serviceUnavailable('The database is not reachable.'));
    }
  });
  return router;
}
