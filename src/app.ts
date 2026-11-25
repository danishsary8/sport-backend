import cors from 'cors';
import express, { Router } from 'express';
import helmet from 'helmet';
import type { Config } from './config/env.js';
import { createContext } from './context.js';
import type { Database } from './db/client.js';
import type { IdentityProvider } from './lib/identity.js';
import { isTestIdentity } from './lib/testIdentity.js';
import { errorHandler, notFoundHandler } from './lib/errors.js';
import type { Logger } from './lib/logger.js';
import {
  createRateLimitMiddleware,
  DEFAULT_GENERAL_MAX_REQUESTS,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  type RateLimitStore,
} from './middleware/rateLimit.js';
import { requestId } from './middleware/requestId.js';
import { httpLogger } from './middleware/httpLog.js';
import { accountRouter } from './modules/account/router.js';
import { adminPricingRouter } from './modules/admin/pricingRouter.js';
import { adminProductsRouter } from './modules/admin/productsRouter.js';
import { adminStockRouter } from './modules/admin/stockRouter.js';
import { adminUsersRouter } from './modules/admin/usersRouter.js';
import { authRouter } from './modules/auth/router.js';
import { branchesRouter } from './modules/branches/router.js';
import { cartRouter } from './modules/cart/router.js';
import { catalogRouter } from './modules/catalog/router.js';
import { checkoutRouter } from './modules/checkout/router.js';
import { orderPaymentsRouter, WEBHOOK_BODY_LIMIT, webhookRouter } from './modules/payments/router.js';
import { customerOrdersRouter } from './modules/orders/customerRouter.js';
import { adminOrdersRouter } from './modules/orders/adminRouter.js';
import { rmaRouter } from './modules/rma/router.js';
import { loyaltyRouter } from './modules/loyalty/router.js';
import { questionsRouter } from './modules/questions/router.js';
import { adminOverviewRouter } from './modules/admin/overviewRouter.js';
import { adminLogsRouter } from './modules/admin/logsRouter.js';
import { systemHealthRouter } from './modules/health/system/router.js';
import { devPaymentsRouter } from './modules/payments/devRouter.js';
import { geoRouter } from './modules/geo/router.js';
import { wishlistRouter } from './modules/wishlist/router.js';
import { healthRouter } from './modules/health/router.js';
import type { BootstrapAdmins } from './modules/users/repo.js';
import { createPaymentProvider, type PaymentProvider } from './modules/payments/provider.js';
import type { Notifier } from './modules/notifications/notifier.js';
import { telegramNotifier } from './modules/notifications/telegram.js';
import { resendNotifier } from './modules/notifications/resend.js';

export interface AppDeps {
  config: Config;
  logger: Logger;
  db: Database;
  identity: IdentityProvider;
  bootstrapAdmins?: BootstrapAdmins;
  /** enabled: the general /v1 limit; routes: per-route limits (default: same as enabled). */
  rateLimit?: { enabled: boolean; generalMax?: number; routes?: boolean };
  /** Shared rate-limit counters (default in-memory; use Redis with several instances). */
  rateLimitStore?: RateLimitStore;
  /** Defaults to PayWay when configured, else the fake provider. */
  payments?: PaymentProvider;
  /** Defaults to Telegram/Resend from config (unconfigured channels report configured: false). */
  notifiers?: { telegram: Notifier; email: Notifier };
}

export function createApp(deps: AppDeps): express.Express {
  const { config, logger } = deps;
  if (config.nodeEnv === 'production' && isTestIdentity(deps.identity)) {
    throw new Error('The test sign-in provider can never be used in production');
  }
  const app = express();

  app.disable('x-powered-by');
  // One reverse proxy hop (load balancer) so req.ip is the real client address.
  app.set('trust proxy', 1);

  app.use(requestId);
  app.use(httpLogger(logger));
  // A JSON API: nothing may load or frame its responses; other helmet defaults stay on.
  app.use(
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  const allowed = new Set(config.corsOrigins);
  app.use(
    cors({
      origin: (origin, callback) => callback(null, origin !== undefined && allowed.has(origin)),
      credentials: true,
    }),
  );

  const keepRawBody = (req: express.Request, _res: unknown, buf: Buffer) => {
    req.rawBody = buf;
  };
  // Payment pushbacks are tiny: refuse anything bigger before the general parser accepts 1 MB.
  app.use('/v1/webhooks', express.json({ limit: WEBHOOK_BODY_LIMIT, verify: keepRawBody }));
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = buf;
      },
    }),
  );

  // Probes sit outside /v1 so they are never rate limited.
  app.use(healthRouter(deps.db));

  const v1 = Router();
  const unlimited = Router();
  if (deps.rateLimit?.enabled !== false) {
    v1.use(
      createRateLimitMiddleware({
        bucket: 'api-general',
        windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS,
        maxRequests: deps.rateLimit?.generalMax ?? DEFAULT_GENERAL_MAX_REQUESTS,
        store: deps.rateLimitStore,
      }),
    );
  }
  const ctx = createContext({
    config,
    logger,
    database: deps.db,
    identity: deps.identity,
    bootstrapAdmins: deps.bootstrapAdmins ?? { phones: config.bootstrapAdminPhones, emails: config.bootstrapAdminEmails },
    payments: deps.payments ?? createPaymentProvider(config),
    notifiers: deps.notifiers ?? {
      telegram: telegramNotifier({ botToken: config.telegramBotToken, chatId: config.telegramChatId }),
      email: resendNotifier({ apiKey: config.resendApiKey, from: config.notificationFromEmail }),
    },
    routeLimits: deps.rateLimit?.routes ?? deps.rateLimit?.enabled !== false,
    rateLimitStore: deps.rateLimitStore,
  });
  v1.use(authRouter(ctx));
  v1.use(accountRouter(ctx));
  v1.use(geoRouter(ctx));
  v1.use(branchesRouter(ctx));
  v1.use(catalogRouter(ctx));
  v1.use(questionsRouter(ctx));
  v1.use(wishlistRouter(ctx));
  v1.use(cartRouter(ctx));
  v1.use(checkoutRouter(ctx));
  v1.use(customerOrdersRouter(ctx));
  v1.use(orderPaymentsRouter(ctx));
  const dev = devPaymentsRouter(ctx);
  if (dev) v1.use(dev);
  unlimited.use(webhookRouter(ctx));
  v1.use(adminUsersRouter(ctx));
  v1.use(adminStockRouter(ctx));
  v1.use(adminProductsRouter(ctx));
  v1.use(adminPricingRouter(ctx));
  v1.use(adminOrdersRouter(ctx));
  v1.use(rmaRouter(ctx));
  v1.use(loyaltyRouter(ctx));
  v1.use(adminOverviewRouter(ctx));
  v1.use(adminLogsRouter(ctx));
  v1.use(systemHealthRouter(ctx));
  // Payment webhooks are signature-checked and re-verified, so they skip the per-IP limiter.
  app.use('/v1', unlimited);
  app.use('/v1', v1);

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
