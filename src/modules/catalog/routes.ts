import { Router } from 'express';
import type { Db } from '../../db/client.js';
import { ApiError } from '../../lib/errors.js';
import { ProductListQuerySchema } from './schemas.js';
import { getProductDetail, getProductPage } from './service.js';

export function catalogRoutes(db: Db | undefined): Router {
  const router = Router();
  const requireDb = () => {
    if (!db) throw ApiError.serviceUnavailable('The catalog database is not configured.');
    return db;
  };

  router.get('/products', async (req, res, next) => {
    try {
      const query = ProductListQuerySchema.parse(req.query);
      res.json(await getProductPage(requireDb(), query));
    } catch (error) {
      next(error);
    }
  });

  router.get('/products/:slug', async (req, res, next) => {
    try {
      res.json(await getProductDetail(requireDb(), req.params.slug));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
