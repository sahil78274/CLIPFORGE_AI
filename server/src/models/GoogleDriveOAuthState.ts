import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * Single-use, short-lived OAuth 2.0 state records.
 *
 * The state parameter sent to Google is HMAC-signed AND the hash of its random
 * nonce is stored here. The callback atomically consumes this record, which
 * prevents replay / CSRF / login-CSRF attacks even if a signed state leaks.
 */
export interface IGoogleDriveOAuthState extends Document {
  userId: Types.ObjectId;
  nonceHash: string;
  redirectPath: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const googleDriveOAuthStateSchema = new Schema<IGoogleDriveOAuthState>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    nonceHash: { type: String, required: true, unique: true, index: true },
    redirectPath: { type: String, required: true, trim: true },
    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true }
);

export const GoogleDriveOAuthState = mongoose.model<IGoogleDriveOAuthState>(
  'GoogleDriveOAuthState',
  googleDriveOAuthStateSchema
);
