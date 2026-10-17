/**
 * WorkspaceMenu — the console's module switcher (design handoff §7.3, digest §6).
 *
 * WHAT: a panel under the rail's header, one row per workspace the viewer may
 * use (Production, Greenhouse, Control & sensors, Company — the shell filters
 * them by the tenant's modules): a fixed colour stripe, the name, what the
 * workspace holds, and that workspace's alarm counts. The current workspace's
 * row is pressed, drawn on the accent-100 fill with a 3px accent bar on its
 * right edge — the bar is the cue (WCAG 1.4.11, 1.4.1): the fill is
 * 1.03–1.14:1 against the paper and a hovered row, the bar 3:1 on the fill
 * (web-theme-token-parity.spec.ts). Choosing another hands its id to
 * `onSelect`.
 *
 * WHY the alarm slot sits beside the row button and not inside it: the counts
 * come through a slot the host fills (`renderAlarms`) — today a labelled
 * preview whose MOCK chip is a button of its own (ALERT-MEDIUM-010), and a
 * button inside a button is invalid HTML that no keyboard can reach.
 *
 * Dismissal is the popover's (FE-HIGH-085): Escape, a press outside, or Tab
 * leaving the panel closes it; focus enters on the current row and goes back
 * to the trigger — unless the reader already put it somewhere else. The host
 * mounts the panel while open and unmounts it on `onClose`.
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type FocusEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';

import { useI18n } from '../../../i18n';

import type { ConsoleWorkspaceId, WorkspaceMenuEntry } from './railTypes';

export interface WorkspaceMenuProps {
  /** The panel's id, the trigger's `aria-controls` target. */
  readonly id: string;
  readonly workspaces: readonly WorkspaceMenuEntry[];
  readonly activeId: ConsoleWorkspaceId | undefined;
  readonly onSelect: (id: ConsoleWorkspaceId) => void;
  readonly onClose: () => void;
  /** The control that opened the panel: a press on it is not "outside", and focus returns to it. */
  readonly triggerRef: RefObject<HTMLElement | null>;
  /** A workspace's alarm counts, drawn at the row's end; null draws none (Company has no alarms). */
  readonly renderAlarms?: (id: ConsoleWorkspaceId) => ReactNode;
}

/** The workspace's identity stripe — the same colour in both themes (theme.css `--color-sd-ws-*`). */
const SWATCH: Readonly<Record<ConsoleWorkspaceId, string>> = {
  aqua: 'bg-sd-ws-aqua',
  gh: 'bg-sd-ws-gh',
  ctl: 'bg-sd-ws-ctl',
  org: 'bg-sd-ws-org',
};

const ROW_SELECTOR = '[data-workspace-row]';

/** Arrow keys rove across the rows, wrapping; Home and End jump to the ends. */
function nextRowIndex(key: string, index: number, count: number): number | null {
  if (key === 'ArrowDown') return (index + 1) % count;
  if (key === 'ArrowUp') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

export function WorkspaceMenu({
  id,
  workspaces,
  activeId,
  onSelect,
  onClose,
  triggerRef,
  renderAlarms,
}: WorkspaceMenuProps): ReactElement {
  const { t } = useI18n();
  const titleId = useId();
  const hintId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Focus enters on the current row; on close it returns to the trigger when
  // it was in the panel (or fell to <body> with the removed panel), never
  // pulled back from wherever the reader moved it.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return undefined;
    const rows = [...panel.querySelectorAll<HTMLElement>(ROW_SELECTOR)];
    const current = rows.find((row) => row.getAttribute('aria-pressed') === 'true') ?? rows[0];
    if (current !== undefined) current.focus();
    const trigger = triggerRef.current;
    return () => {
      const focused = document.activeElement;
      const lost = focused === null || focused === document.body || panel.contains(focused);
      if (lost && trigger !== null && trigger.isConnected) trigger.focus();
    };
  }, [triggerRef]);

  // A press outside the panel and its trigger closes it (the trigger toggles
  // on its own). mousedown/touchstart, as useClickOutside listens.
  useEffect(() => {
    const handle = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const panel = panelRef.current;
      const trigger = triggerRef.current;
      if (panel !== null && panel.contains(target)) return;
      if (trigger !== null && trigger.contains(target)) return;
      onCloseRef.current();
    };
    document.addEventListener('mousedown', handle);
    document.addEventListener('touchstart', handle);
    return () => {
      document.removeEventListener('mousedown', handle);
      document.removeEventListener('touchstart', handle);
    };
  }, [triggerRef]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      // Kept from the page: an open phone overlay below must not close with it.
      event.stopPropagation();
      onClose();
      return;
    }
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>(ROW_SELECTOR)];
    const index = rows.findIndex((row) => row === document.activeElement);
    if (index === -1) return;
    const next = nextRowIndex(event.key, index, rows.length);
    if (next === null) return;
    event.preventDefault();
    rows[next].focus();
  };

  // Tab leaving the panel for the page closes it; moving to the trigger does not.
  const handleBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget;
    if (!(next instanceof Node)) return;
    if (event.currentTarget.contains(next)) return;
    const trigger = triggerRef.current;
    if (trigger !== null && trigger.contains(next)) return;
    onClose();
  };

  const choose = (workspaceId: ConsoleWorkspaceId): void => {
    if (workspaceId !== activeId) onSelect(workspaceId);
    onClose();
  };

  return (
    <div
      ref={panelRef}
      id={id}
      role="dialog"
      aria-labelledby={titleId}
      aria-describedby={hintId}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      className="sd-corners fixed left-3 top-[86px] z-[71] flex w-[min(400px,calc(100vw-24px))] flex-col border border-sd-rule bg-sd-paper text-sd-ink shadow-(--shadow-sd-lg)"
    >
      <div className="flex flex-col gap-[3px] border-b border-sd-rule px-[18px] pb-3 pt-3.5">
        <h2
          id={titleId}
          className="text-[12.5px] font-bold uppercase leading-normal tracking-[0.1em] text-sd-neutral-700"
        >
          {t('console.workspaceMenu.title')}
        </h2>
        <p id={hintId} className="text-pretty text-sm leading-[1.4] text-sd-neutral-800">
          {t('console.workspaceMenu.hint')}
        </p>
      </div>
      <ul className="flex flex-col">
        {workspaces.map((workspace) => {
          const active = workspace.id === activeId;
          const alarms = renderAlarms === undefined ? null : renderAlarms(workspace.id);
          return (
            <li
              key={workspace.id}
              className={`flex min-h-16 items-stretch border-b border-sd-ink/8 ${
                active
                  ? 'bg-sd-accent-100 shadow-[inset_-3px_0_0_var(--color-sd-accent)]'
                  : 'hover:bg-sd-neutral-200'
              }`}
            >
              <button
                type="button"
                data-workspace-row=""
                aria-pressed={active}
                onClick={() => choose(workspace.id)}
                className={`flex min-w-0 flex-1 items-center gap-3.5 py-2.5 pl-3 text-left text-sd-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sd-accent ${
                  alarms === null ? 'pr-[18px]' : 'pr-2'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`w-1.5 shrink-0 self-stretch ${SWATCH[workspace.id]}`}
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="font-display-sd text-[19px] font-semibold leading-[1.1]">
                    {workspace.label}
                  </span>
                  <span className="text-[13.5px] leading-[1.35] text-sd-neutral-700">
                    {workspace.description}
                  </span>
                </span>
              </button>
              {alarms !== null && (
                <span className="flex shrink-0 items-center pl-1.5 pr-[18px]">{alarms}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
