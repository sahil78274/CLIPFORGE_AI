import type {
  ClipItem,
  ClipMetadata,
  CreditPackageItem,
  CreditTransactionItem,
  DashboardOverviewData,
  NotificationItem,
  PaymentRecord,
  ProcessingJobItem,
  ProjectItem,
  ProjectProcessingSettings,
  SystemCapabilities,
  UrlCheckResult,
  User,
  WalletSummary,
} from '../types/api';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api/v1';

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(message: string, status: number, code = 'API_ERROR', details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: 'include',
  });

  const contentType = res.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await res.json() : null;

  if (!res.ok) {
    const errObj = payload?.error || {};
    throw new ApiError(
      errObj.message || payload?.message || `Request failed with status ${res.status}`,
      res.status,
      errObj.code || 'REQUEST_FAILED',
      errObj.details
    );
  }

  return (payload?.data !== undefined ? payload.data : payload) as T;
}

export const api = {
  auth: {
    register: (body: { name: string; email: string; password: string }) =>
      request<{ user: User; wallet: WalletSummary }>('/auth/register', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    login: (body: { email: string; password: string }) =>
      request<{ user: User; wallet: WalletSummary }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    logout: () => request<{ loggedOut: boolean }>('/auth/logout', { method: 'POST' }),
    me: () => request<{ user: User; wallet: WalletSummary }>('/auth/me'),
    forgotPassword: (email: string) =>
      request<{ message: string; devResetToken?: string }>('/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email }),
      }),
    resetPassword: (body: { token: string; password: string }) =>
      request<{ message: string }>('/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },

  users: {
    overview: () => request<DashboardOverviewData>('/users/overview'),
    updateProfile: (body: {
      name?: string;
      preferences?: Partial<User['preferences']>;
    }) =>
      request<{ user: User }>('/users/profile', {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    changePassword: (body: { currentPassword: string; newPassword: string }) =>
      request<{ message: string }>('/users/password', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    globalSearch: (q: string) =>
      request<{ projects: ProjectItem[]; clips: ClipItem[] }>(
        `/users/search?q=${encodeURIComponent(q)}`
      ),
  },

  projects: {
    list: (params?: { page?: number; limit?: number; status?: string; search?: string }) => {
      const qs = new URLSearchParams();
      if (params?.page) qs.set('page', String(params.page));
      if (params?.limit) qs.set('limit', String(params.limit));
      if (params?.status) qs.set('status', params.status);
      if (params?.search) qs.set('search', params.search);
      return request<{
        items: ProjectItem[];
        total: number;
        page: number;
        totalPages: number;
      }>(`/projects?${qs.toString()}`);
    },
    get: (id: string) =>
      request<{ project: ProjectItem; clips: ClipItem[]; jobs: ProcessingJobItem[] }>(
        `/projects/${id}`
      ),
    create: (body: {
      title: string;
      description?: string;
      settings?: Partial<ProjectProcessingSettings>;
    }) =>
      request<{ project: ProjectItem }>('/projects', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    delete: (id: string) => request<{ deleted: boolean }>(`/projects/${id}`, { method: 'DELETE' }),
  },

  videos: {
    checkUrl: (url: string) =>
      request<UrlCheckResult>('/videos/check-url', {
        method: 'POST',
        body: JSON.stringify({ url }),
      }),
    importUrl: (body: {
      title: string;
      url: string;
      settings: ProjectProcessingSettings;
      autoStart?: boolean;
    }) =>
      request<{ project: ProjectItem; job?: ProcessingJobItem }>('/videos/import-url', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    uploadWithProgress: (opts: {
      file: File;
      title: string;
      settings: ProjectProcessingSettings;
      autoStart?: boolean;
      onProgress?: (percent: number) => void;
      signal?: AbortSignal;
    }): Promise<{ project: ProjectItem; job?: ProcessingJobItem }> => {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const formData = new FormData();
        formData.append('video', opts.file);
        formData.append('title', opts.title);
        formData.append('settings', JSON.stringify(opts.settings));
        formData.append('autoStart', String(opts.autoStart !== false));

        xhr.open('POST', `${API_BASE}/videos/upload`, true);
        xhr.withCredentials = true;

        if (opts.signal) {
          if (opts.signal.aborted) {
            xhr.abort();
            reject(new ApiError('Upload cancelled', 499, 'UPLOAD_CANCELLED'));
            return;
          }
          opts.signal.addEventListener('abort', () => {
            xhr.abort();
          });
        }

        xhr.upload.onprogress = (evt) => {
          if (evt.lengthComputable && opts.onProgress) {
            opts.onProgress(Math.round((evt.loaded / evt.total) * 100));
          }
        };

        xhr.onload = () => {
          let payload: any = null;
          try {
            payload = JSON.parse(xhr.responseText);
          } catch {
            payload = null;
          }
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(payload?.data || payload);
          } else {
            const errObj = payload?.error || {};
            reject(
              new ApiError(
                errObj.message || `Upload failed (${xhr.status})`,
                xhr.status,
                errObj.code || 'UPLOAD_FAILED'
              )
            );
          }
        };

        xhr.onerror = () =>
          reject(new ApiError('Network error during video upload', 0, 'NETWORK_ERROR'));
        xhr.onabort = () => reject(new ApiError('Upload cancelled by user', 499, 'UPLOAD_CANCELLED'));

        xhr.send(formData);
      });
    },
  },

  jobs: {
    capabilities: () => request<SystemCapabilities>('/jobs/capabilities'),
    list: (params?: { status?: string; page?: number; limit?: number }) => {
      const qs = new URLSearchParams();
      if (params?.status) qs.set('status', params.status);
      if (params?.page) qs.set('page', String(params.page));
      if (params?.limit) qs.set('limit', String(params.limit));
      return request<{ items: ProcessingJobItem[]; total: number }>(`/jobs?${qs.toString()}`);
    },
    get: (id: string) => request<{ job: ProcessingJobItem }>(`/jobs/${id}`),
    startForProject: (projectId: string) =>
      request<{ job: ProcessingJobItem }>(`/jobs/project/${projectId}/start`, { method: 'POST' }),
    cancel: (id: string) =>
      request<{ job: ProcessingJobItem }>(`/jobs/${id}/cancel`, { method: 'POST' }),
    retry: (id: string) =>
      request<{ job: ProcessingJobItem }>(`/jobs/${id}/retry`, { method: 'POST' }),
  },

  clips: {
    list: (params?: {
      page?: number;
      limit?: number;
      projectId?: string;
      aspectRatio?: string;
      status?: string;
      search?: string;
      sort?: string;
    }) => {
      const qs = new URLSearchParams();
      if (params?.page) qs.set('page', String(params.page));
      if (params?.limit) qs.set('limit', String(params.limit));
      if (params?.projectId) qs.set('projectId', params.projectId);
      if (params?.aspectRatio) qs.set('aspectRatio', params.aspectRatio);
      if (params?.status) qs.set('status', params.status);
      if (params?.search) qs.set('search', params.search);
      if (params?.sort) qs.set('sort', params.sort);
      return request<{ items: ClipItem[]; total: number; page: number; totalPages: number }>(
        `/clips?${qs.toString()}`
      );
    },
    get: (id: string) => request<{ clip: ClipItem }>(`/clips/${id}`),
    rename: (id: string, title: string) =>
      request<{ clip: ClipItem }>(`/clips/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title }),
      }),
    updateMetadata: (id: string, metadata: Partial<ClipMetadata>) =>
      request<{ clip: ClipItem }>(`/clips/${id}/metadata`, {
        method: 'PATCH',
        body: JSON.stringify({ metadata }),
      }),
    regenerateMetadata: (id: string) =>
      request<{ clip: ClipItem; aiNotice?: string }>(`/clips/${id}/regenerate-metadata`, {
        method: 'POST',
      }),
    regenerateVideo: (
      id: string,
      overrides?: { aspectRatio?: string; captionStyle?: Partial<ClipItem['captionStyle']> }
    ) =>
      request<{ job: ProcessingJobItem }>(`/clips/${id}/regenerate`, {
        method: 'POST',
        body: JSON.stringify(overrides || {}),
      }),
    delete: (id: string) => request<{ deleted: boolean }>(`/clips/${id}`, { method: 'DELETE' }),
    getBulkDownloadUrl: (clipIds: string[]) =>
      request<{ downloadUrl: string }>('/clips/bulk-download-token', {
        method: 'POST',
        body: JSON.stringify({ clipIds }),
      }),
  },

  wallet: {
    get: () => request<{ wallet: WalletSummary }>('/wallet'),
    transactions: (params?: { page?: number; limit?: number; type?: string }) => {
      const qs = new URLSearchParams();
      if (params?.page) qs.set('page', String(params.page));
      if (params?.limit) qs.set('limit', String(params.limit));
      if (params?.type) qs.set('type', params.type);
      return request<{
        items: CreditTransactionItem[];
        total: number;
        page: number;
        totalPages: number;
      }>(`/wallet/transactions?${qs.toString()}`);
    },
  },

  payments: {
    packages: () => request<{ items: CreditPackageItem[] }>('/payments/packages'),
    history: () => request<{ items: PaymentRecord[] }>('/payments/history'),
    createOrder: (packageId: string, useSandboxSimulator = false) =>
      request<{
        paymentId: string;
        orderId: string;
        amountPaise: number;
        currency: string;
        keyId: string;
        isDevelopmentMode: boolean;
        sandboxSignaturePreview?: string;
        sandboxPaymentId?: string;
      }>('/payments/create-order', {
        method: 'POST',
        body: JSON.stringify({ packageId, useSandboxSimulator }),
      }),
    verifyPayment: (body: {
      razorpayOrderId: string;
      razorpayPaymentId: string;
      razorpaySignature: string;
    }) =>
      request<{ payment: PaymentRecord; wallet: WalletSummary }>('/payments/verify', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },

  notifications: {
    list: () => request<{ items: NotificationItem[]; unreadCount: number }>('/notifications'),
    markRead: (id: string) =>
      request<{ notification: NotificationItem }>(`/notifications/${id}/read`, {
        method: 'PATCH',
      }),
    markAllRead: () => request<{ updated: number }>('/notifications/read-all', { method: 'POST' }),
    submitContact: (body: { name: string; email: string; subject: string; message: string }) =>
      request<{ submitted: boolean; ticketRef: string }>('/notifications/contact', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },

  admin: {
    overview: () => request<any>('/admin/overview'),
    users: (params?: { search?: string; status?: string; page?: number }) => {
      const qs = new URLSearchParams();
      if (params?.search) qs.set('search', params.search);
      if (params?.status) qs.set('status', params.status);
      if (params?.page) qs.set('page', String(params.page));
      return request<{ items: Array<User & { wallet?: WalletSummary }>; total: number }>(
        `/admin/users?${qs.toString()}`
      );
    },
    updateUserStatus: (userId: string, status: 'active' | 'suspended', reason: string) =>
      request<{ user: User }>(`/admin/users/${userId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status, reason }),
      }),
    adjustCredits: (userId: string, amount: number, reason: string) =>
      request<{ wallet: WalletSummary }>(`/admin/users/${userId}/credits`, {
        method: 'POST',
        body: JSON.stringify({ amount, reason }),
      }),
    userActivity: (userId: string) => request<any>(`/admin/users/${userId}/activity`),
    jobs: (params?: { status?: string; page?: number }) => {
      const qs = new URLSearchParams();
      if (params?.status) qs.set('status', params.status);
      if (params?.page) qs.set('page', String(params.page));
      return request<{ items: any[]; total: number }>(`/admin/jobs?${qs.toString()}`);
    },
    payments: () => request<{ items: any[] }>('/admin/payments'),
    refundPayment: (paymentId: string, reason: string) =>
      request<{ payment: PaymentRecord }>(`/admin/payments/${paymentId}/refund`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    packages: () => request<{ items: CreditPackageItem[] }>('/admin/packages'),
    upsertPackage: (pkg: Partial<CreditPackageItem> & { _id?: string }) =>
      request<{ item: CreditPackageItem }>(
        pkg._id ? `/admin/packages/${pkg._id}` : '/admin/packages',
        {
          method: pkg._id ? 'PATCH' : 'POST',
          body: JSON.stringify(pkg),
        }
      ),
    getConfig: () => request<{ config: any }>('/admin/config'),
    updateConfig: (body: any) =>
      request<{ config: any }>('/admin/config', {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    auditLogs: () => request<{ items: any[]; errorLogs: any[] }>('/admin/audit-logs'),
  },
};
