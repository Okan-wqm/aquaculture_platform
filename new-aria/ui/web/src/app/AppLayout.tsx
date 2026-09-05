import { KERNEL_READ_PERMISSION } from '../../../shared/api-contract.ts';
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { clearToken } from '../api/token-store.ts';
import { Badge, type BadgeTone } from '../design/Badge.tsx';
import { Icon, type IconName } from '../design/Icon.tsx';
import { useHealth } from './HealthProvider.tsx';
import { ROUTES } from './routes.ts';
import './AppLayout.css';

interface NavEntry {
  readonly to: string;
  readonly label: string;
  readonly end?: boolean | undefined;
}

interface NavGroupDef {
  readonly title: string;
  readonly permission: string | null;
  readonly icon: IconName;
  readonly entries: ReadonlyArray<NavEntry>;
}

/** Navigation is grouped by the two bodies of evidence the console projects. */
const NAV_GROUPS: ReadonlyArray<NavGroupDef> = [
  {
    title: 'Core',
    permission: KERNEL_READ_PERMISSION,
    icon: 'core',
    entries: [
      { to: ROUTES.overview, label: 'Overview', end: true },
      { to: ROUTES.cycles, label: 'Cycles' },
      { to: ROUTES.governance, label: 'Governance' },
      { to: ROUTES.findings, label: 'Findings' },
      { to: ROUTES.beliefs, label: 'Beliefs' },
      { to: ROUTES.pressures, label: 'Pressures' },
      { to: ROUTES.humanRequired, label: 'Human required' },
      { to: ROUTES.agents, label: 'Agents' },
      { to: ROUTES.plans, label: 'Plans' },
      { to: ROUTES.tools, label: 'Tools' },
      { to: ROUTES.reports, label: 'Reports' },
      { to: ROUTES.ledgers, label: 'Ledgers' },
      { to: ROUTES.actions, label: 'Actions' },
    ],
  },
  {
    title: 'Legal',
    permission: null,
    icon: 'legal',
    entries: [{ to: ROUTES.legalCases, label: 'Cases' }],
  },
];

/**
 * Profile colour, owned by the shell.
 *
 * WHY: the health strip renders on every screen, including before any feature
 * module has loaded, so the shell must not reach into a feature helper for it.
 * The value itself is never translated — only its colour is interpretation.
 */
const PROFILE_TONES: Readonly<Record<string, BadgeTone>> = {
  observe: 'info',
  standard: 'success',
  strict: 'warning',
  frozen: 'danger',
  autonomous: 'accent',
};

function NavGroup({ group }: { readonly group: NavGroupDef }): ReactNode {
  return (
    <div className="sidebar__group">
      <h2 className="sidebar__group-title">
        <Icon name={group.icon} size={12} />
        {group.title}
      </h2>
      <ul className="sidebar__list">
        {group.entries.map((entry) => (
          <li key={entry.to}>
            <NavLink
              to={entry.to}
              end={entry.end ?? false}
              className={({ isActive }) => `sidebar__link${isActive ? ' sidebar__link--active' : ''}`}
            >
              {entry.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Profile, actions and version — the three facts that change how the console behaves. */
function HealthStrip(): ReactNode {
  const health = useHealth();
  const profile = health.profile;

  if (health.state.status === 'error') {
    return (
      <div className="sidebar__health">
        <Badge tone="danger">Health unavailable</Badge>
        <button type="button" className="button button--sm button--ghost" onClick={health.reload}>
          <Icon name="refresh" size={13} />
          Refresh
        </button>
      </div>
    );
  }

  if (health.state.status === 'loading' && health.state.data === null) {
    return <div className="sidebar__health muted">Reading health…</div>;
  }

  const data = health.state.data;
  return (
    <div className="sidebar__health">
      {health.me !== null ? (
        <div className="sidebar__health-row">
          <span className="sidebar__health-key">Signed in</span>
          <span title={`${health.me.principal.id} — role ${health.me.principal.role}; every receipt and access row names this principal`}>
            {health.me.principal.displayName} <Badge tone={health.me.principal.role === 'lawyer' ? 'warning' : 'muted'}>{health.me.principal.role}</Badge>
          </span>
        </div>
      ) : null}
      {health.can(KERNEL_READ_PERMISSION) ? <div className="sidebar__health-row">
        <span className="sidebar__health-key">Profile</span>
        {profile === null ? (
          <Badge tone="muted" title="The runtime profile is read from the governance ledger.">
            unknown
          </Badge>
        ) : (
          <Badge tone={PROFILE_TONES[profile] ?? 'neutral'} mono title="Runtime profile, verbatim from the kernel.">
            {profile}
          </Badge>
        )}
      </div> : null}
      {data !== null ? (
        <>
          <div className="sidebar__health-row">
            <span className="sidebar__health-key">Actions</span>
            <Badge tone={data.actionsEnabled ? 'warning' : 'muted'} title="ARIA_UI_ALLOW_ACTIONS on the projection server">
              {data.actionsEnabled ? 'enabled' : 'disabled'}
            </Badge>
          </div>
          <div className="sidebar__health-row">
            <span className="sidebar__health-key">Version</span>
            <span className="mono">{data.version}</span>
          </div>
          {!data.toolsDirPresent ? (
            <Badge tone="danger" title="ARIA_TOOLS_DIR does not resolve to a readable directory.">
              tools dir missing
            </Badge>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * The application shell: fixed sidebar, grouped navigation, health strip, content column.
 *
 * WHY: state that governs the whole console (which profile is live, whether
 * actions are permitted, which build is serving) must be visible from every
 * screen, not only from Overview.
 * WHAT: below 1000px the sidebar becomes an overlay drawer opened from the top
 * bar; it closes on navigation so a tap never leaves the operator behind a scrim.
 */
export function AppLayout(): ReactNode {
  const health = useHealth();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  return (
    <div className={navOpen ? 'layout layout--nav-open' : 'layout'}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <button
          type="button"
          className="button button--ghost button--icon topbar__toggle"
          aria-expanded={navOpen}
          aria-controls="sidebar-nav"
          onClick={() => setNavOpen((open) => !open)}
        >
          <Icon name="menu" title={navOpen ? 'Close navigation' : 'Open navigation'} />
        </button>
        <span className="topbar__brand">
          <span className="topbar__wordmark">ARIA</span>
          <span className="topbar__sub">Operator console</span>
        </span>
      </header>
      <aside className="sidebar" id="sidebar-nav">
        <div className="sidebar__brand">
          <span className="sidebar__wordmark">ARIA</span>
          <span className="sidebar__brand-sub">Operator console</span>
        </div>
        <nav className="sidebar__nav" aria-label="Main navigation">
          {NAV_GROUPS.filter((group) => group.permission === null || health.can(group.permission)).map((group) => (
            <NavGroup key={group.title} group={group} />
          ))}
        </nav>
        <footer className="sidebar__footer">
          <HealthStrip />
          <button type="button" className="button button--sm" onClick={clearToken}>
            <Icon name="sign-out" size={13} />
            Sign out
          </button>
        </footer>
      </aside>
      <button
        type="button"
        className="layout__scrim"
        tabIndex={navOpen ? 0 : -1}
        aria-label="Close navigation"
        aria-hidden={navOpen ? undefined : true}
        onClick={() => setNavOpen(false)}
      />
      <main id="main" className="content" tabIndex={-1}>
        <div className="content__column">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
