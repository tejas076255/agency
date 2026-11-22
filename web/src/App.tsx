import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ConfirmProvider } from './components/ConfirmDialog';
import { Layout } from './components/Layout';
import { DetailSkeleton } from './components/Skeleton';
import { Alert, FullPageSpinner } from './components/ui';
import { AuthProvider, useAuth } from './lib/auth';
import { AdvertisingPage, BillingPage, LocalSeoPage, YouTubePage } from './pages/Channels';
import { ClientFormPage } from './pages/ClientForm';
import { ClientsPage } from './pages/Clients';
import { DashboardPage } from './pages/Dashboard';
import { JobsPage } from './pages/Jobs';
import { PrivacyPage, TermsPage } from './pages/Legal';
import { LoginPage } from './pages/Login';
import { OnboardingPage } from './pages/Onboarding';
import { ProspectsPage } from './pages/Prospects';
import { ReportsPage } from './pages/Reports';
import { SettingsPage } from './pages/Settings';

// Charts (recharts) are heavy: load the client detail page only when it's opened.
const ClientDetailPage = lazy(() =>
  import('./pages/ClientDetail').then((m) => ({ default: m.ClientDetailPage })),
);

/** Sends each visitor to the right place based on login + onboarding state. */
function Guard({
  need,
  children,
}: {
  need: 'guest' | 'onboarding' | 'agency';
  children: ReactNode;
}) {
  const { me, loading, error } = useAuth();
  if (loading) return <FullPageSpinner />;
  if (error && !me) {
    return (
      <div className="mx-auto max-w-md p-6">
        <Alert>Could not reach the server: {error}</Alert>
      </div>
    );
  }
  const signedIn = Boolean(me?.user);
  const hasAgency = Boolean(me?.agency);

  if (need === 'guest' && signedIn)
    return <Navigate to={hasAgency ? '/dashboard' : '/onboarding'} replace />;
  if (need !== 'guest' && !signedIn) return <Navigate to="/login" replace />;
  if (need === 'onboarding' && hasAgency) return <Navigate to="/dashboard" replace />;
  if (need === 'agency' && !hasAgency) return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}

function BrandColor({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const brand = me?.agency?.brandColor ?? '#4f46e5';
  return <div style={{ ['--brand' as string]: brand }}>{children}</div>;
}

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <BrandColor>
          <ConfirmProvider>
            <Routes>
              {/* Public pages (linked from the Google consent screen). */}
              <Route path="/privacy" element={<PrivacyPage />} />
              <Route path="/terms" element={<TermsPage />} />
              <Route
                path="/login"
                element={
                  <Guard need="guest">
                    <LoginPage />
                  </Guard>
                }
              />
              <Route
                path="/onboarding"
                element={
                  <Guard need="onboarding">
                    <OnboardingPage />
                  </Guard>
                }
              />
              <Route
                element={
                  <Guard need="agency">
                    <Layout />
                  </Guard>
                }
              >
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/clients" element={<ClientsPage />} />
                <Route path="/clients/new" element={<ClientFormPage />} />
                <Route
                  path="/clients/:id"
                  element={
                    <Suspense fallback={<DetailSkeleton />}>
                      <ClientDetailPage />
                    </Suspense>
                  }
                />
                <Route path="/clients/:id/edit" element={<ClientFormPage />} />
                <Route path="/local-seo" element={<LocalSeoPage />} />
                <Route path="/advertising" element={<AdvertisingPage />} />
                <Route path="/youtube" element={<YouTubePage />} />
                <Route path="/billing" element={<BillingPage />} />
                <Route path="/prospects" element={<ProspectsPage />} />
                <Route path="/prospects/:auditId" element={<ProspectsPage />} />
                <Route path="/reports" element={<ReportsPage />} />
                <Route path="/jobs" element={<JobsPage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Route>
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </ConfirmProvider>
        </BrandColor>
      </BrowserRouter>
    </AuthProvider>
  );
}
