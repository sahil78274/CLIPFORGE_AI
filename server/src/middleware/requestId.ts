import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../utils/logger';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      rawBody?: Buffer;
    }
  }
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id'];
  const id =
    typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 64
      ? incoming
      : crypto.randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-Id', id);

  const start = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api/')) {
      logger.info('http_request', {
        requestId: id,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        durationMs: Date.now() - start,
      });
    }
  });

  next();
}
