import { Navigate, Outlet } from 'react-router-dom';
import { useSession } from '../lib/useSession';
import AppShell from '../components/AppShell';

export default function ProtectedRoute() {
  const { data, isLoading } = useSession();

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center text-text-muted">
        Checking session…
      </div>
    );
  }

  if (!data?.authenticated) {
    return <Navigate to="/login" replace />;
  }

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
