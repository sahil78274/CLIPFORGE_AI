import mongoose, { Document, Schema, Types } from 'mongoose';
import type { GoogleConnectedChannel } from '@clipforge/shared';

export interface IAuthorizedDriveSelection {
  fileId: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  durationSec: number | null;
  width?: number | null;
  height?: number | null;
  thumbnailUrl?: string;
  selectedAt: Date;
}

/**
 * Stores a ClipForge user's Google OAuth 2.0 connection.
 * Security invariants:
 * - Only `encryptedRefreshToken` is persisted in MongoDB (AES-256-GCM encrypted at rest).
 * - Short-lived OAuth access tokens are NEVER stored permanently in MongoDB; they live only in
 *   volatile server memory and are refreshed on demand via `encryptedRefreshToken`.
 * - `authorizedFiles` tracks Picker-selected file IDs verified against Drive API for this user.
 */
export interface IUserGoogleIntegration extends Document {
  userId: Types.ObjectId;
  googleAccountId: string;
  email: string;
  displayName?: string;
  avatarUrl?: string;
  encryptedRefreshToken: string;
  scopes: string[];
  channels: GoogleConnectedChannel[];
  authorizedFiles: IAuthorizedDriveSelection[];
  lastSyncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const authorizedDriveSelectionSchema = new Schema<IAuthorizedDriveSelection>(
  {
    fileId: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    mimeType: { type: String, required: true, trim: true },
    sizeBytes: { type: Number, default: null },
    durationSec: { type: Number, default: null },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    thumbnailUrl: { type: String, trim: true },
    selectedAt: { type: Date, default: () => new Date() },
  },
  { _id: false }
);

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
    encryptedRefreshToken: { type: String, required: true },
    scopes: { type: [String], default: [] },
    channels: { type: [Schema.Types.Mixed] as any, default: [] },
    authorizedFiles: { type: [authorizedDriveSelectionSchema], default: [] },
    lastSyncedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true }
);

export const UserGoogleIntegration = mongoose.model<IUserGoogleIntegration>(
  'UserGoogleIntegration',
  userGoogleIntegrationSchema
);
