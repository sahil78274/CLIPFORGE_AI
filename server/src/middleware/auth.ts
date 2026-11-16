import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { User, type IUser } from '../models/User';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';

export const AUTH_COOKIE_NAME = 'clipforge_access_token';

export interface JwtAccessPayload {
  sub: string;
  role: 'user' | 'admin';
  email: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: IUser;
    }
  }
}

export function signAccessToken(user: IUser): string {
  const payload: JwtAccessPayload = {
    sub: String(user._id),
    role: user.role,
    email: user.email,
  };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as any,
  });
}

function extractToken(req: Request): string | null {
  if (req.cookies && typeof req.cookies[AUTH_COOKIE_NAME] === 'string') {
    return req.cookies[AUTH_COOKIE_NAME];
  }
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractToken(req);
    if (!token) {
      throw new UnauthorizedError('Please sign in to access this resource');
    }

    let decoded: JwtAccessPayload;
    try {
      decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtAccessPayload;
    } catch {
      throw new UnauthorizedError('Invalid or expired session token', 'INVALID_TOKEN');
    }

    const user = await User.findById(decoded.sub);
    if (!user) {
      throw new UnauthorizedError('Account no longer exists', 'USER_NOT_FOUND');
    }
    if (user.status === 'suspended') {
      throw new ForbiddenError(
        'Your account has been suspended by a platform administrator',
        'ACCOUNT_SUSPENDED'
      );
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

export async function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = extractToken(req);
    if (!token) {
      next();
      return;
    }
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtAccessPayload;
    const user = await User.findById(decoded.sub);
    if (user && user.status === 'active') {
      req.user = user;
    }
  } catch {
    // Ignore invalid/expired optional auth tokens
  }
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    next(new UnauthorizedError());
    return;
  }
  if (req.user.role !== 'admin') {
    next(new ForbiddenError('Administrator privileges required', 'ADMIN_REQUIRED'));
    return;
  }
  next();
}
