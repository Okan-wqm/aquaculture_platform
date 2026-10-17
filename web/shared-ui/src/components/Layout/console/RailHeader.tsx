/**
 * RailHeader — the rail's 80 px head (digest §3.2, §4): the blueprint logo
 * plate and, while expanded, the tenant and workspace names; one button that
 * opens the workspace menu. Beside it the collapse control (desktop) or the
 * close control (phone overlay).
 *
 * WHY one trigger for the plate and the names: the prototype draws two
 * buttons that do the same thing, which a keyboard user meets twice and a
 * screen reader announces twice. One button wraps both; collapsed, only the
 * plate shows and the button keeps its accessible name (tenant, workspace)
 * and its tooltip. A session that names no tenant draws no tenant line and
 * leaves the tenant out of that name, rather than an empty line and a
 * leading comma.
 */
import { ChevronDown, PanelLeftClose, X } from 'lucide-react';
import { useId, useRef, useState, type ReactElement, type ReactNode } from 'react';

import { useI18n } from '../../../i18n';

import type { ConsoleWorkspaceId, WorkspaceMenuEntry } from './railTypes';
import { WorkspaceMenu } from './WorkspaceMenu';

export interface RailHeaderProps {
  /** The session's tenant (`useAuthContext().user.tenantName`); null names none. */
  readonly tenantName: string | null;
  readonly logoSrc: string;
  readonly workspaces: readonly WorkspaceMenuEntry[];
  readonly activeWorkspace: WorkspaceMenuEntry | undefined;
  readonly onWorkspaceSelect: (id: ConsoleWorkspaceId) => void;
  readonly renderWorkspaceAlarms?: (id: ConsoleWorkspaceId) => ReactNode;
  /** The icon column: only the plate shows. */
  readonly collapsed: boolean;
  /** The phone overlay: a close control instead of the collapse control. */
  readonly overlay: boolean;
  readonly onCollapse: () => void;
  readonly onCloseOverlay: () => void;
}

const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sd-accent';

export function RailHeader({
  tenantName,
  logoSrc,
  workspaces,
  activeWorkspace,
  onWorkspaceSelect,
  renderWorkspaceAlarms,
  collapsed,
  overlay,
  onCollapse,
  onCloseOverlay,
}: RailHeaderProps): ReactElement {
  const { t } = useI18n();
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const workspaceLabel = activeWorkspace === undefined ? '' : activeWorkspace.label;
  const tenant = tenantName === null || tenantName === '' ? null : tenantName;

  return (
    <div className="flex h-20 shrink-0 items-center gap-3 border-b border-sd-rule px-3.5">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
        aria-label={
          tenant === null
            ? t('console.rail.workspaceTriggerNoTenant', { workspace: workspaceLabel })
            : t('console.rail.workspaceTrigger', { tenant, workspace: workspaceLabel })
        }
        title={workspaceLabel}
        onClick={() => setMenuOpen((open) => !open)}
        className={`group flex min-w-0 flex-1 items-center gap-3 text-left ${FOCUS_RING}`}
      >
        <span className="sd-corners grid size-12 shrink-0 place-items-center border border-sd-rule bg-sd-cream">
          <img src={logoSrc} alt="" className="size-[38px] object-contain" />
        </span>
        {!collapsed && (
          <span className="flex min-h-[52px] min-w-0 flex-1 flex-col justify-center gap-px px-2 py-0.5 group-hover:bg-sd-neutral-200">
            {tenant !== null && (
              <span className="truncate text-[13px] text-sd-neutral-700">{tenant}</span>
            )}
            <span className="flex max-w-full items-center gap-1.5 font-display-sd text-xl font-semibold leading-[1.1] text-sd-accent-800">
              <span className="truncate">{workspaceLabel}</span>
              <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
            </span>
          </span>
        )}
      </button>

      {overlay && (
        <button
          type="button"
          onClick={onCloseOverlay}
          aria-label={t('header.closeNavigation')}
          className={`grid size-10 shrink-0 place-items-center text-sd-neutral-800 hover:bg-sd-neutral-200 ${FOCUS_RING}`}
        >
          <X size={20} strokeWidth={1.5} aria-hidden="true" />
        </button>
      )}
      {!overlay && !collapsed && (
        <button
          type="button"
          data-rail-focus="collapse"
          onClick={onCollapse}
          aria-label={t('sidebar.collapse')}
          title={t('sidebar.collapse')}
          className={`grid size-10 shrink-0 place-items-center text-sd-neutral-800 hover:bg-sd-accent/10 active:bg-sd-accent/20 ${FOCUS_RING}`}
        >
          <PanelLeftClose size={20} strokeWidth={1.5} aria-hidden="true" />
        </button>
      )}

      {menuOpen && (
        <WorkspaceMenu
          id={menuId}
          workspaces={workspaces}
          activeId={activeWorkspace === undefined ? undefined : activeWorkspace.id}
          onSelect={onWorkspaceSelect}
          onClose={() => setMenuOpen(false)}
          triggerRef={triggerRef}
          renderAlarms={renderWorkspaceAlarms}
        />
      )}
    </div>
  );
}
