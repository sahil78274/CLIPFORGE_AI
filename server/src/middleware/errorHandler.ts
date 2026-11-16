import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { ZodError } from 'zod';
import { env } from '../config/env';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    requestId: req.requestId,
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: `Endpoint ${req.method} ${req.originalUrl} does not exist`,
    },
  });
}

export function centralErrorHandler(
  err: any,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      requestId: req.requestId,
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      success: false,
      requestId: req.requestId,
      error: {
        code: 'VALIDATION_ERROR',
        message: err.issues[0]?.message || 'Validation failed',
        details: err.flatten(),
      },
    });
    return;
  }

  if (err instanceof multer.MulterError) {
    const msg =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'Uploaded video exceeds maximum permitted file size'
        : err.message;
    res.status(400).json({
      success: false,
      requestId: req.requestId,
      error: {
        code: 'UPLOAD_VALIDATION_ERROR',
        message: msg,
      },
    });
    return;
  }

  if (err?.code === 11000) {
    res.status(409).json({
      success: false,
      requestId: req.requestId,
      error: {
        code: 'DUPLICATE_RESOURCE',
        message: 'A record with that unique value already exists',
      },
    });
    return;
  }

  if (err?.name === 'CastError') {
    res.status(400).json({
      success: false,
      requestId: req.requestId,
      error: {
        code: 'INVALID_IDENTIFIER',
        message: 'Invalid resource ID format',
      },
    });
    return;
  }

  logger.error('Unhandled server error', {
    requestId: req.requestId,
    path: req.originalUrl,
    err,
  });

  res.status(500).json({
    success: false,
    requestId: req.requestId,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message:
        env.NODE_ENV === 'production'
          ? 'An unexpected internal server error occurred'
          : err?.message || 'Internal server error',
    },
  });
}
