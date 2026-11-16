import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * A Drive file that the authenticated user explicitly picked with the official
 * Google Picker AND that the backend independently verified with that user's
 * own OAuth credentials. Jobs only ever reference this opaque selection _id;
 * a client-supplied Drive file ID is never trusted on its own.
 */
export interface IGoogleDriveFileSelection extends Document {
  userId: Types.ObjectId;
  connectionGoogleAccountId: string;
  fileId: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  thumbnailLink?: string;
  md5Checksum?: string;
  sha256Checksum?: string;
  driveModifiedTime?: string;
  expiresAt: Date;
  lastVerifiedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const googleDriveFileSelectionSchema = new Schema<IGoogleDriveFileSelection>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    connectionGoogleAccountId: { type: String, required: true, trim: true },
    fileId: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    mimeType: { type: String, required: true, trim: true },
    sizeBytes: { type: Number, default: null },
    durationSec: { type: Number, default: null },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    thumbnailLink: { type: String },
    md5Checksum: { type: String },
    sha256Checksum: { type: String },
    driveModifiedTime: { type: String },
    expiresAt: { type: Date, required: true, index: true },
    lastVerifiedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true }
);

googleDriveFileSelectionSchema.index({ userId: 1, createdAt: -1 });

export const GoogleDriveFileSelection = mongoose.model<IGoogleDriveFileSelection>(
  'GoogleDriveFileSelection',
  googleDriveFileSelectionSchema
);
