import { Compass, Home } from 'lucide-react';
import type { JSX } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui';

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
    <div className="min-h-screen flex flex-col items-center justify-center px-6 text-center">
      <div className="w-16 h-16 rounded-2xl bg-acc-dim flex items-center justify-center mb-5">
        <Compass size={32} className="text-acc" />
      </div>
      <h1 className="text-head font-bold text-ink-1 mb-2">Page not found</h1>
      <p className="text-body text-ink-2 mb-1">
        This link doesn&apos;t match any page in AquaMobil.
      </p>
      <p className="text-meta font-mono text-ink-3 break-all mb-6">{pathname}</p>
      <Button variant="primary" onClick={() => navigate('/', { replace: true })}>
        <Home size={18} />
        Back to Home
      </Button>
    </div>
  );
}
