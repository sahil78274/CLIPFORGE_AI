import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { requestIdMiddleware } from './middleware/requestId';
import { globalApiLimiter } from './middleware/rateLimit';
import { centralErrorHandler, notFoundHandler } from './middleware/errorHandler';
import { apiV1Router } from './routes';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.use(requestIdMiddleware);

  const isProd = env.NODE_ENV === 'production';

  app.use(
    helmet({
      // Allow live preview iframe embedding in development preview environments
      frameguard: isProd ? { action: 'sameorigin' } : false,
      contentSecurityPolicy: isProd ? undefined : false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    })
  );

  const allowedOrigins = env.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) {
          callback(null, true);
          return;
        }
        if (
          allowedOrigins.includes(origin) ||
          (!isProd && (origin.endsWith('.e2b.app') || origin.startsWith('http://localhost:')))
        ) {
          callback(null, true);
          return;
        }
        callback(new Error(`Origin ${origin} not permitted by CORS allowlist`));
      },
      credentials: true,
    })
  );

  app.use(cookieParser());

  // Preserve raw Buffer for Razorpay webhook HMAC verification
  app.use(
    express.json({
      limit: '2mb',
      verify: (req: any, _res, buf) => {
        if (req.originalUrl && req.originalUrl.includes('/payments/webhook')) {
          req.rawBody = Buffer.from(buf);
        }
      },
    })
  );
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  app.use('/api/v1', globalApiLimiter, apiV1Router);

  app.use(notFoundHandler);
  app.use(centralErrorHandler);

  return app;
}
