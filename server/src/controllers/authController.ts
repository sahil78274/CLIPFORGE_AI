import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import type { CookieOptions, Request, Response } from 'express';
import { env } from '../config/env';
import { AUTH_COOKIE_NAME, signAccessToken } from '../middleware/auth';
import {
  Notification,
  PasswordResetToken,
  User,
  type IUser,
} from '../models';
import { ensureUserWallet } from '../services/walletService';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  UnauthorizedError,
} from '../utils/errors';

function serializeUser(user: IUser) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    preferences: user.preferences,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

function getAuthCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production' ? true : env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAME_SITE,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  };
}

export const authController = {
  async register(req: Request, res: Response) {
    const email = String(req.body.email).toLowerCase().trim();
    const existing = await User.findOne({ email });
    if (existing) {
      throw new ConflictError('An account with this email address already exists', 'EMAIL_EXISTS');
    }

    const passwordHash = await bcrypt.hash(req.body.password, 12);
    const user = await User.create({
      name: req.body.name.trim(),
      email,
      passwordHash,
      role: 'user',
      status: 'active',
      lastLoginAt: new Date(),
    });

    const wallet = await ensureUserWallet(user._id, true);
    const token = signAccessToken(user);
    res.cookie(AUTH_COOKIE_NAME, token, getAuthCookieOptions());

    res.status(201).json({
      success: true,
      data: {
        user: serializeUser(user),
        wallet,
      },
    });
  },

  async login(req: Request, res: Response) {
    const email = String(req.body.email).toLowerCase().trim();
    const user = await User.findOne({ email }).select('+passwordHash');
    if (!user) {
      throw new UnauthorizedError('Invalid email or password', 'INVALID_CREDENTIALS');
    }

    const matches = await bcrypt.compare(req.body.password, user.passwordHash);
    if (!matches) {
      throw new UnauthorizedError('Invalid email or password', 'INVALID_CREDENTIALS');
    }

    if (user.status === 'suspended') {
      throw new ForbiddenError(
        'Your account has been suspended by an administrator',
        'ACCOUNT_SUSPENDED'
      );
    }

    user.lastLoginAt = new Date();
    await user.save();

    const wallet = await ensureUserWallet(user._id, false);
    const token = signAccessToken(user);
    res.cookie(AUTH_COOKIE_NAME, token, getAuthCookieOptions());

    res.json({
      success: true,
      data: {
        user: serializeUser(user),
        wallet,
      },
    });
  },

  async logout(_req: Request, res: Response) {
    res.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
    res.json({
      success: true,
      data: { loggedOut: true },
    });
  },

  async me(req: Request, res: Response) {
    const user = req.user!;
    const wallet = await ensureUserWallet(user._id, false);
    res.json({
      success: true,
      data: {
        user: serializeUser(user),
        wallet,
      },
    });
  },

  async forgotPassword(req: Request, res: Response) {
    const email = String(req.body.email).toLowerCase().trim();
    const user = await User.findOne({ email });

    let devResetToken: string | undefined;
    if (user && user.status === 'active') {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

      await PasswordResetToken.create({
        userId: user._id,
        tokenHash,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        requestedIp: req.ip,
      });

      if (env.NODE_ENV !== 'production') {
        devResetToken = rawToken;
      }
    }

    res.json({
      success: true,
      data: {
        message:
          'If an active account matches that email, password reset instructions have been issued.',
        ...(devResetToken ? { devResetToken } : {}),
      },
    });
  },

  async resetPassword(req: Request, res: Response) {
    const rawToken = String(req.body.token).trim();
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const record = await PasswordResetToken.findOne({
      tokenHash,
      usedAt: { $exists: false },
      expiresAt: { $gt: new Date() },
    });

    if (!record) {
      throw new BadRequestError(
        'Reset token is invalid or has expired. Request a new password reset.',
        'INVALID_RESET_TOKEN'
      );
    }

    const user = await User.findById(record.userId);
    if (!user) {
      throw new BadRequestError('Associated user account not found');
    }

    user.passwordHash = await bcrypt.hash(req.body.password, 12);
    await user.save();

    record.usedAt = new Date();
    await record.save();

    await Notification.create({
      userId: user._id,
      type: 'security',
      title: 'Password Reset Completed',
      message: 'Your account password was reset successfully.',
    });

    res.json({
      success: true,
      data: { message: 'Password has been updated. You can now sign in.' },
    });
  },
};
