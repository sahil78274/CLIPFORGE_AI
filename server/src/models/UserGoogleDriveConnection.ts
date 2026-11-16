import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * Dedicated Google Drive connection for the authenticated ClipForge user.
 *
 * SECURITY: only the AES-256-GCM encrypted *refresh token* lives in MongoDB.
 * Short-lived access tokens are held in a process-memory cache and are NEVER
 * persisted to a database, log, or the browser beyond the Picker hand-off.
 * The OAuth client secret is only ever read from server-side env variables.
 */
export interface IUserGoogleDriveConnection extends Document {
  userId: Types.ObjectId;
  googleAccountId: string;
  email: string;
  displayName?: string;
  avatarUrl?: string;
  encryptedRefreshToken: string;
  scopes: string[];
  status: 'active' | 'revoked';
  connectedAt: Date;
  lastRefreshedAt?: Date;
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const userGoogleDriveConnectionSchema = new Schema<IUserGoogleDriveConnection>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    googleAccountId: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    displayName: { type: String, trim: true },
    avatarUrl: { type: String, trim: true },
    encryptedRefreshToken: { type: String, required: true },
    scopes: { type: [String], default: [] },
    status: {
      type: String,
      enum: ['active', 'revoked'],
      default: 'active',
      index: true,
    },
    connectedAt: { type: Date, default: () => new Date() },
    lastRefreshedAt: { type: Date },
    lastUsedAt: { type: Date },
  },
  { timestamps: true }
);

export const UserGoogleDriveConnection = mongoose.model<IUserGoogleDriveConnection>(
  'UserGoogleDriveConnection',
  userGoogleDriveConnectionSchema
);
