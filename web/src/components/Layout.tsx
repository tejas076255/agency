import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

const navItems = [
  { to: '/dashboard', label: 'Overview' },
  { to: '/clients', label: 'Clients' },
  { to: '/local-seo', label: 'Local SEO' },
  { to: '/advertising', label: 'Advertising' },
  { to: '/youtube', label: 'YouTube' },
  { to: '/reports', label: 'Reports' },
  { to: '/jobs', label: 'Job logs' },
  { to: '/billing', label: 'Plan' },
  { to: '/settings', label: 'Settings' },
];

export function Layout() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const agency = me?.agency;
  const user = me?.user;

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `rounded-lg px-3 py-2 text-sm font-medium ${
      isActive ? 'bg-[var(--brand)]/10 text-[var(--brand)]' : 'text-slate-600 hover:bg-slate-100'
    }`;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4">
          <div className="flex min-w-0 items-center gap-3">
            {agency?.logoUrl ? (
              <img src={agency.logoUrl} alt="" className="h-8 w-8 rounded object-contain" />
            ) : (
              <div className="flex h-8 w-8 items-center justify-center rounded bg-[var(--brand)] text-sm font-bold text-white">
                {agency?.name.charAt(0).toUpperCase() ?? 'A'}
              </div>
            )}
            <span className="truncate font-semibold">{agency?.name ?? 'Agency Autopilot'}</span>
          </div>

          <div className="hidden items-center gap-3 md:flex">
            {user?.pictureUrl && (
              <img
                src={user.pictureUrl}
                alt=""
                className="h-8 w-8 rounded-full"
                referrerPolicy="no-referrer"
              />
            )}
            <span className="max-w-40 truncate text-sm text-slate-600">{user?.name}</span>
            <button onClick={handleLogout} className="text-sm text-slate-500 hover:text-slate-900">
              Sign out
            </button>
          </div>

          <button
            className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 md:hidden"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="Open menu"
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        </div>

        {/* Desktop navigation (second row so all sections fit). */}
        <nav
          aria-label="Main"
          className="mx-auto hidden max-w-6xl gap-1 overflow-x-auto px-4 pb-2 md:flex"
        >
          {navItems.map((n) => (
            <NavLink key={n.to} to={n.to} className={linkClass}>
              {n.label}
            </NavLink>
          ))}
        </nav>

        {menuOpen && (
          <div className="border-t border-slate-200 px-4 py-3 md:hidden">
            <nav className="flex flex-col gap-1">
              {navItems.map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  className={linkClass}
                  onClick={() => setMenuOpen(false)}
                >
                  {n.label}
                </NavLink>
              ))}
              <button
                onClick={handleLogout}
                className="rounded-lg px-3 py-2 text-left text-sm text-slate-600 hover:bg-slate-100"
              >
                Sign out ({user?.email})
              </button>
            </nav>
          </div>
        )}
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
