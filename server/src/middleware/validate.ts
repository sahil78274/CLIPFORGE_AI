import type { NextFunction, Request, Response } from 'express';
import type { ZodSchema } from 'zod';
import { BadRequestError } from '../utils/errors';

export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      next(
        new BadRequestError(
          firstIssue
            ? `${firstIssue.path.join('.') || 'Field'}: ${firstIssue.message}`
            : 'Invalid request payload',
          'VALIDATION_ERROR',
          parsed.error.flatten()
        )
      );
      return;
    }
    req.body = parsed.data;
    next();
  };
}
