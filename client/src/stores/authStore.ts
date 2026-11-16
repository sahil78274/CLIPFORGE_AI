import { create } from 'zustand';
import { api } from '../services/api';
import type { User, WalletSummary } from '../types/api';

interface AuthState {
  user: User | null;
  wallet: WalletSummary | null;
  initialized: boolean;
  loading: boolean;
  refreshSession: () => Promise<void>;
  setSession: (user: User, wallet: WalletSummary) => void;
  updateWallet: (wallet: WalletSummary) => void;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  wallet: null,
  initialized: false,
  loading: true,

  refreshSession: async () => {
    try {
      const data = await api.auth.me();
      set({ user: data.user, wallet: data.wallet, initialized: true, loading: false });
    } catch {
      set({ user: null, wallet: null, initialized: true, loading: false });
    }
  },

  setSession: (user, wallet) => {
    set({ user, wallet, initialized: true, loading: false });
  },

  updateWallet: (wallet) => {
    set({ wallet });
  },

  logout: async () => {
    try {
      await api.auth.logout();
    } catch {
      // Ignore network error during logout
    }
    set({ user: null, wallet: null, initialized: true, loading: false });
  },
}));
