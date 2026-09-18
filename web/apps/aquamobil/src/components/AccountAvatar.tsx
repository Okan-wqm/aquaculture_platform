/**
 * AccountAvatar — the initials button that is the app's ONE route to /account.
 *
 * WHY it is its own component: v4 took Account out of the dock, which makes this
 * avatar the only way a worker reaches theme, gloves, language, sync, cache and
 * sign-out. Both shells wear it now — the phone header (AppHeader) and the
 * tablet board's top bar — and a second hand-rolled copy would mean two initials
 * rules, two touch floors and two destinations to keep in step. It was extracted
 * from AppHeader rather than duplicated out of it.
 */
import { type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '@/hooks/useAuth';

/** First letters of the first and last word — "Ola Nordvik" → "ON". */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.charAt(0) ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? '') : '';
  return (first + last).toUpperCase();
}

export function AccountAvatar(): ReactElement {
  const navigate = useNavigate();
  const { user } = useAuth();
  const name = user?.name ?? user?.email ?? '';

  return (
    <button
      type="button"
      onClick={() => navigate('/account')}
      aria-label="Account"
      className="w-10 h-10 min-h-touch min-w-touch shrink-0 rounded-xl bg-acc text-acc-on font-mono text-meta font-semibold inline-flex items-center justify-center touch-feedback focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc"
    >
      {initials(name)}
    </button>
  );
}
