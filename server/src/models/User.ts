import mongoose, { Document, Schema } from 'mongoose';
import type { AspectRatio } from '@clipforge/shared';

export interface IUser extends Document {
  name: string;
  email: string;
  passwordHash: string;
  role: 'user' | 'admin';
  status: 'active' | 'suspended';
  preferences: {
    defaultAspectRatio: AspectRatio;
    defaultLanguage: string;
    watermarkText: string;
    emailNotifications: boolean;
  };
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['user', 'admin'], default: 'user', index: true },
    status: { type: String, enum: ['active', 'suspended'], default: 'active', index: true },
    preferences: {
      defaultAspectRatio: { type: String, enum: ['9:16', '1:1', '16:9'], default: '9:16' },
      defaultLanguage: { type: String, default: 'en' },
      watermarkText: { type: String, default: '' },
      emailNotifications: { type: Boolean, default: true },
    },
    lastLoginAt: { type: Date },
  },
  { timestamps: true }
);

export const User = mongoose.model<IUser>('User', userSchema);
