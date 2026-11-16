import { useCallback } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../stores/authStore';

export function useWalletRefresh() {
  const updateWallet = useAuthStore((s) => s.updateWallet);

  return useCallback(async () => {
    try {
      const res = await api.wallet.get();
      updateWallet(res.wallet);
    } catch {
      // ignore silent refresh error
    }
  }, [updateWallet]);
}
