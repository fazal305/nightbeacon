import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

const NAV_ITEMS = [
  { to: '/dashboard', key: 'dashboard' },
  { to: '/live', key: 'live' },
  { to: '/sources', key: 'sources' },
  { to: '/activity', key: 'activity' },
  { to: '/settings', key: 'settings' },
];

function SidebarContent({ t, onNavigate, onLogout }) {
  return (
    <>
      <div className="px-4 py-5 font-mono text-sm tracking-wide text-text-muted">
        {t('appName')}
      </div>
      <nav className="flex flex-1 flex-col gap-1 px-2">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            className={({ isActive }) =>
              `rounded px-3 py-2 text-sm ${
                isActive ? 'bg-panel-raised text-text' : 'text-text-muted hover:text-text'
              }`
            }
          >
            {t(`nav.${item.key}`)}
          </NavLink>
        ))}
      </nav>
      <button
        onClick={onLogout}
        className="m-2 rounded px-3 py-2 text-left text-sm text-text-muted hover:text-text"
      >
        Log out
      </button>
    </>
  );
}

export default function AppShell({ children }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => queryClient.setQueryData(['session'], { authenticated: false }),
  });

  return (
    <div className="flex min-h-screen flex-col bg-bg text-text sm:flex-row">
      {/* Mobile top bar */}
      <div className="flex items-center justify-between border-b border-border bg-panel px-4 py-3 sm:hidden">
        <span className="font-mono text-sm tracking-wide text-text-muted">{t('appName')}</span>
        <button
          onClick={() => setDrawerOpen(true)}
          aria-label="Open navigation menu"
          className="rounded border border-border px-3 py-1.5 text-sm text-text"
        >
          Menu
        </button>
      </div>

      {/* Mobile drawer overlay */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 flex sm:hidden">
          <div className="flex w-64 flex-col border-r border-border bg-panel">
            <SidebarContent
              t={t}
              onNavigate={() => setDrawerOpen(false)}
              onLogout={() => logout.mutate()}
            />
          </div>
          <button
            aria-label="Close navigation menu"
            className="flex-1 bg-black/60"
            onClick={() => setDrawerOpen(false)}
          />
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-panel sm:flex">
        <SidebarContent t={t} onNavigate={undefined} onLogout={() => logout.mutate()} />
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
