import React, { createContext, useContext, useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';

const AuthContext = createContext<ReturnType<typeof useAuthStore.getState> | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const store = useAuthStore();

  useEffect(() => {
    if (!store.initialized) {
      void store.refreshSession();
    }
  }, [store.initialized]);

  return <AuthContext.Provider value={store}>{children}</AuthContext.Provider>;
};

export function useAuth() {
  const ctx = useContext(AuthContext);
  const store = useAuthStore();
  return ctx ?? store;
}
