import { Compass, Home } from 'lucide-react';
import type { JSX } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * MOB-LOW-001: catch-all destination for unknown routes. The previous silent
 * `Navigate to="/"` masked broken deep links (see BUG-16 — the /culling/*
 * compat redirects were only discovered because users landed on the dashboard
 * with no explanation). Showing the failed path makes broken links observable
 * in bug reports while keeping a one-tap recovery to Home. Statically imported
 * (not lazy) so it is precached with the shell and works cold-offline.
 */
export function NotFoundPage(): JSX.Element {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col items-center justify-center px-6 text-center">
      <div className="w-16 h-16 rounded-2xl bg-ocean-100 dark:bg-ocean-900/40 flex items-center justify-center mb-5">
        <Compass size={32} className="text-ocean-600 dark:text-ocean-300" />
      </div>
      <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-2">Page not found</h1>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">
        This link doesn&apos;t match any page in AquaMobil.
      </p>
      <p className="text-xs font-mono text-gray-500 dark:text-gray-500 break-all mb-6">{pathname}</p>
      <button
        onClick={() => navigate('/', { replace: true })}
        className="min-h-[44px] inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-ocean-600 text-white font-semibold touch-feedback hover:bg-ocean-700 transition-colors"
      >
        <Home size={18} />
        Back to Home
      </button>
    </div>
  );
}
