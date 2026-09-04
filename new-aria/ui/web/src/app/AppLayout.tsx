import type { ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { clearToken } from '../api/token-store.ts';
import { Badge } from '../design/Badge.tsx';
import { useHealth } from './HealthProvider.tsx';
import { ROUTES } from './routes.ts';
import './AppLayout.css';

interface NavEntry {
  readonly to: string;
  readonly label: string;
  readonly end?: boolean | undefined;
}

const CORE_NAV: ReadonlyArray<NavEntry> = [
  { to: ROUTES.overview, label: 'Genel Bakış', end: true },
  { to: ROUTES.cycles, label: 'Döngüler' },
  { to: ROUTES.governance, label: 'Yönetişim' },
  { to: ROUTES.findings, label: 'Bulgular' },
  { to: ROUTES.beliefs, label: 'İnançlar' },
  { to: ROUTES.pressures, label: 'Basınçlar' },
  { to: ROUTES.humanRequired, label: 'İnsan Gerekli' },
  { to: ROUTES.agents, label: 'Ajanlar' },
  { to: ROUTES.plans, label: 'Planlar' },
  { to: ROUTES.tools, label: 'Araçlar' },
  { to: ROUTES.reports, label: 'Raporlar' },
  { to: ROUTES.ledgers, label: 'Defterler (ledger)' },
  { to: ROUTES.actions, label: 'Eylemler' },
];

const LEGAL_NAV: ReadonlyArray<NavEntry> = [{ to: ROUTES.legalCases, label: 'Davalar' }];

function NavGroup({ title, entries }: { readonly title: string; readonly entries: ReadonlyArray<NavEntry> }): ReactNode {
  return (
    <div className="sidebar__group">
      <h2 className="sidebar__group-title">{title}</h2>
      <ul className="sidebar__list">
        {entries.map((entry) => (
          <li key={entry.to}>
            <NavLink to={entry.to} end={entry.end ?? false} className={({ isActive }) => `sidebar__link${isActive ? ' sidebar__link--active' : ''}`}>
              {entry.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AppLayout(): ReactNode {
  const health = useHealth();
  return (
    <div className="layout">
      <a className="skip-link" href="#main">
        İçeriğe geç
      </a>
      <aside className="sidebar">
        <div className="sidebar__brand">
          <span className="sidebar__brand-name">ARIA</span>
          <span className="sidebar__brand-sub">Operatör Konsolu</span>
        </div>
        <nav className="sidebar__nav" aria-label="Ana gezinme">
          <NavGroup title="ARIA Çekirdek" entries={CORE_NAV} />
          <NavGroup title="Hukuk" entries={LEGAL_NAV} />
        </nav>
        <footer className="sidebar__footer">
          {health.state.status === 'success' ? (
            <div className="sidebar__health">
              <span className="mono">v{health.state.data.version}</span>
              <Badge tone={health.state.data.actionsEnabled ? 'warning' : 'muted'} title="ARIA_UI_ALLOW_ACTIONS">
                actions: {health.state.data.actionsEnabled ? 'enabled' : 'disabled'}
              </Badge>
              {!health.state.data.toolsDirPresent ? <Badge tone="danger">tools dir missing</Badge> : null}
            </div>
          ) : health.state.status === 'error' ? (
            <div className="sidebar__health">
              <Badge tone="danger">health: error</Badge>
              <button type="button" className="button button--ghost" onClick={health.reload}>
                Yenile
              </button>
            </div>
          ) : (
            <div className="sidebar__health muted">health…</div>
          )}
          <button type="button" className="button" onClick={clearToken}>
            Çıkış
          </button>
        </footer>
      </aside>
      <main id="main" className="content" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
