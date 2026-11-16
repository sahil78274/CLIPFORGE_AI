import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './context/AuthContext';
import { ToastViewport } from './components/ui';
import { AdminRoute, ProtectedRoute } from './components/RouteGuards';
import { PublicLayout } from './layouts/PublicLayout';
import { DashboardLayout } from './layouts/DashboardLayout';
import { AdminLayout } from './layouts/AdminLayout';

import { HomePage } from './pages/public/HomePage';
import {
  AboutPage,
  ContactPage,
  FeaturesPage,
  HowItWorksPage,
  PricingPage,
} from './pages/public/MarketingPages';
import {
  ForgotPasswordPage,
  LoginPage,
  RegisterPage,
} from './pages/public/AuthPages';
import { PrivacyPolicyPage, TermsPage } from './pages/public/LegalPages';

import { OverviewPage } from './pages/dashboard/OverviewPage';
import { CreateClipsPage } from './pages/dashboard/CreateClipsPage';
import { ProjectDetailPage, ProjectsPage } from './pages/dashboard/ProjectsPages';
import { ProcessingQueuePage } from './pages/dashboard/ProcessingQueuePage';
import { ClipLibraryPage } from './pages/dashboard/ClipLibraryPage';
import {
  BillingHistoryPage,
  CreditWalletPage,
} from './pages/dashboard/WalletAndBillingPages';
import {
  HelpSupportPage,
  SettingsPage,
} from './pages/dashboard/SettingsAndSupportPages';

import {
  AdminConfigPage,
  AdminJobsPage,
  AdminOverviewPage,
  AdminPaymentsPage,
  AdminUsersPage,
} from './pages/admin/AdminPages';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export const App: React.FC = () => {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            {/* Public Website */}
            <Route element={<PublicLayout />}>
              <Route path="/" element={<HomePage />} />
              <Route path="/features" element={<FeaturesPage />} />
              <Route path="/how-it-works" element={<HowItWorksPage />} />
              <Route path="/pricing" element={<PricingPage />} />
              <Route path="/about" element={<AboutPage />} />
              <Route path="/contact" element={<ContactPage />} />
              <Route path="/login" element={<LoginPage />} />
              <Route path="/register" element={<RegisterPage />} />
              <Route path="/forgot-password" element={<ForgotPasswordPage />} />
              <Route path="/reset-password" element={<ForgotPasswordPage />} />
              <Route path="/privacy" element={<PrivacyPolicyPage />} />
              <Route path="/terms" element={<TermsPage />} />
            </Route>

            {/* Protected Creator Studio Dashboard */}
            <Route
              path="/dashboard"
              element={
                <ProtectedRoute>
                  <DashboardLayout />
                </ProtectedRoute>
              }
            >
              <Route index element={<OverviewPage />} />
              <Route path="create" element={<CreateClipsPage />} />
              <Route path="projects" element={<ProjectsPage />} />
              <Route path="projects/:id" element={<ProjectDetailPage />} />
              <Route path="queue" element={<ProcessingQueuePage />} />
              <Route path="clips" element={<ClipLibraryPage />} />
              <Route path="wallet" element={<CreditWalletPage />} />
              <Route path="billing" element={<BillingHistoryPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="support" element={<HelpSupportPage />} />
            </Route>

            {/* Protected Admin Console */}
            <Route
              path="/admin"
              element={
                <AdminRoute>
                  <AdminLayout />
                </AdminRoute>
              }
            >
              <Route index element={<AdminOverviewPage />} />
              <Route path="users" element={<AdminUsersPage />} />
              <Route path="jobs" element={<AdminJobsPage />} />
              <Route path="payments" element={<AdminPaymentsPage />} />
              <Route path="config" element={<AdminConfigPage />} />
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          <ToastViewport />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
};
