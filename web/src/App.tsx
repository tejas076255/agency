import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Alert, FullPageSpinner, Spinner } from './components/ui';
import { AuthProvider, useAuth } from './lib/auth';
import { lazy, Suspense } from 'react';
import { ClientFormPage } from './pages/ClientForm';
import { DashboardPage } from './pages/Dashboard';
import { JobsPage } from './pages/Jobs';
import { LoginPage } from './pages/Login';
import { OnboardingPage } from './pages/Onboarding';
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
          <Routes>
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
              <Route path="/clients/new" element={<ClientFormPage />} />
              <Route
                path="/clients/:id"
                element={
                  <Suspense fallback={<Spinner />}>
                    <ClientDetailPage />
                  </Suspense>
                }
              />
              <Route path="/clients/:id/edit" element={<ClientFormPage />} />
              <Route path="/jobs" element={<JobsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </BrandColor>
      </BrowserRouter>
    </AuthProvider>
  );
}
