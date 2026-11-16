import mongoose, { Document, Schema, Types } from 'mongoose';
import type { GoogleConnectedChannel } from '@clipforge/shared';

export interface IUserGoogleIntegration extends Document {
  userId: Types.ObjectId;
  googleAccountId: string;
  email: string;
  displayName?: string;
  avatarUrl?: string;
  encryptedAccessToken: string;
  encryptedRefreshToken?: string;
  tokenExpiresAt?: Date;
  scopes: string[];
  channels: GoogleConnectedChannel[];
  lastSyncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const userGoogleIntegrationSchema = new Schema<IUserGoogleIntegration>(
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
    encryptedAccessToken: { type: String, required: true },
    encryptedRefreshToken: { type: String },
    tokenExpiresAt: { type: Date },
    scopes: { type: [String], default: [] },
    channels: { type: [Schema.Types.Mixed] as any, default: [] },
    lastSyncedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true }
);

export const UserGoogleIntegration = mongoose.model<IUserGoogleIntegration>(
  'UserGoogleIntegration',
  userGoogleIntegrationSchema
);
