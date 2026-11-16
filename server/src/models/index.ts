import bcrypt from 'bcryptjs';
import { MAX_VIDEO_UPLOAD_SIZE_MB } from '@clipforge/shared';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { User } from './User';
import { CreditWallet } from './CreditWallet';
import { CreditTransaction } from './CreditTransaction';
import { CreditPackage, SystemConfig, type ISystemConfig } from './SystemConfig';
import { UserGoogleIntegration } from './UserGoogleIntegration';
import { UserGoogleDriveConnection } from './UserGoogleDriveConnection';
import { GoogleDriveOAuthState } from './GoogleDriveOAuthState';
import { GoogleDriveFileSelection } from './GoogleDriveFileSelection';

export * from './User';
export * from './Project';
export * from './Video';
export * from './Clip';
export * from './ProcessingJob';
export * from './CreditWallet';
export * from './CreditTransaction';
export * from './Payment';
export * from './Notification';
export * from './AdminAuditLog';
export * from './PasswordResetToken';
export * from './SystemConfig';
export * from './UserGoogleIntegration';
export * from './UserGoogleDriveConnection';
export * from './GoogleDriveOAuthState';
export * from './GoogleDriveFileSelection';

export async function getOrCreateSystemConfig(): Promise<ISystemConfig> {
  let cfg = await SystemConfig.findOne({ singletonKey: 'global' });
  if (!cfg) {
    cfg = await SystemConfig.create({ singletonKey: 'global' });
  }
  if (!cfg.uploadLimitMigrated) {
    // Only upgrade the previous default, preserving custom administrator limits.
    await SystemConfig.updateOne(
      { _id: cfg._id, uploadLimitMigrated: { $ne: true } },
      { $set: { uploadLimitMigrated: true, ...(cfg.maxUploadSizeMb === 250 ? { maxUploadSizeMb: MAX_VIDEO_UPLOAD_SIZE_MB } : {}) } }
    );
    cfg = (await SystemConfig.findOne({ singletonKey: 'global' }))!;
  }
  if (cfg.maxVideoDurationSec === 3600 && !cfg.chunkDurationSec) {
    // Upgrade legacy 1-hour default config to 10-hour chunked processing defaults
    cfg.maxVideoDurationSec = 36000;
    cfg.chunkDurationSec = 600;
    cfg.chunkOverlapSec = 5;
    await cfg.save();
  }
  return cfg;
}

export async function ensureSystemBootstrap(): Promise<void> {
  // Initialize model indexes
  await Promise.all([
    User.init(),
    CreditWallet.init(),
    CreditTransaction.init(),
    CreditPackage.init(),
    SystemConfig.init(),
    UserGoogleIntegration.init(),
    UserGoogleDriveConnection.init(),
    GoogleDriveOAuthState.init(),
    GoogleDriveFileSelection.init(),
  ]);

  const cfg = await getOrCreateSystemConfig();

  const existingPkgCount = await CreditPackage.countDocuments({});
  if (existingPkgCount === 0) {
    await CreditPackage.insertMany([
      {
        name: 'Creator Starter Pack',
        slug: 'creator-starter',
        description: 'Configurable credit top-up for solo YouTubers, Reels creators, and podcasters.',
        credits: 120,
        amountPaise: 49900,
        currency: 'INR',
        popular: false,
        active: true,
        features: [
          '120 processing credits (admin-configurable)',
          '9:16, 1:1 & 16:9 smart reframing',
          'Animated word-highlight subtitles',
          'No monthly expiration',
        ],
        sortOrder: 1,
      },
      {
        name: 'Studio Growth Pack',
        slug: 'studio-growth',
        description: 'Ideal for weekly podcasts, interviews, coaching cohorts, and active channels.',
        credits: 350,
        amountPaise: 119900,
        currency: 'INR',
        popular: true,
        active: true,
        features: [
          '350 processing credits (admin-configurable)',
          'OpenCV speaker face tracking',
          'Multi-platform AI titles, hooks & hashtags',
          'Bulk ZIP downloads & custom watermarks',
        ],
        sortOrder: 2,
      },
      {
        name: 'Agency & Production Pack',
        slug: 'agency-production',
        description: 'High-volume processing credits for editors, agencies, and digital marketing teams.',
        credits: 1000,
        amountPaise: 299900,
        currency: 'INR',
        popular: false,
        active: true,
        features: [
          '1,000 processing credits (admin-configurable)',
          'Full audio mastering & ambient beds',
          'Priority batch clip regeneration',
          'Complete ledger & receipt auditability',
        ],
        sortOrder: 3,
      },
    ]);
    logger.info('Seeded default configurable CreditPackage records');
  }

  // Ensure bootstrap admin exists if configured
  if (env.ADMIN_BOOTSTRAP_EMAIL && env.ADMIN_BOOTSTRAP_PASSWORD) {
    const adminEmail = env.ADMIN_BOOTSTRAP_EMAIL.toLowerCase().trim();
    const existingAdmin = await User.findOne({ email: adminEmail });
    if (!existingAdmin) {
      const passwordHash = await bcrypt.hash(env.ADMIN_BOOTSTRAP_PASSWORD, 12);
      const admin = await User.create({
        name: 'Platform Administrator',
        email: adminEmail,
        passwordHash,
        role: 'admin',
        status: 'active',
      });
      const wallet = await CreditWallet.create({
        userId: admin._id,
        availableCredits: cfg.welcomeCredits,
        reservedCredits: 0,
        lifetimeEarnedCredits: cfg.welcomeCredits,
      });
      await CreditTransaction.create({
        userId: admin._id,
        walletId: wallet._id,
        type: 'welcome_bonus',
        amount: cfg.welcomeCredits,
        balanceAfter: cfg.welcomeCredits,
        reservedAfter: 0,
        referenceType: 'signup',
        referenceId: String(admin._id),
        idempotencyKey: `welcome:${String(admin._id)}`,
        description: 'Initial administrator welcome credit allocation',
      });
      logger.info('Created bootstrap admin user', { email: adminEmail });
    }
  }
}
