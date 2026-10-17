/**
 * ViewAsRoleList — the user menu's "View as role" section (README §7.4, §8;
 * decision D20: admins only — the shell passes the list to admins and to no
 * one else).
 *
 * WHAT: a labelled group of toggle rows, one per tenant role: a radio-style
 * dot, the role's name and how many console pages it can open. The row of the
 * role the console is showing is pressed: its dot is filled. The empty dot's
 * ring is neutral-600, which holds 3:1 on the paper in both themes
 * (neutral-500 was 2.57:1 in Drawing). A pick goes to the shell and closes
 * the menu; the preview is client-side only — the hint says so, because every
 * change still runs with the user's own role.
 */
import { useId, type ReactElement } from 'react';

import { useI18n } from '../../../i18n';

import type { UserMenuViewAs } from './headerTypes';

export interface ViewAsRoleListProps extends UserMenuViewAs {
  /** Closes the menu after a pick. */
  readonly onPicked: () => void;
}

export function ViewAsRoleList({
  roles,
  activeRoleId,
  onViewAs,
  onPicked,
}: ViewAsRoleListProps): ReactElement {
  const { t } = useI18n();
  const id = useId();
  const headingId = `${id}-heading`;
  const hintId = `${id}-hint`;

  return (
    <div
      role="group"
      aria-labelledby={headingId}
      aria-describedby={hintId}
      className="flex flex-col border-b border-sd-rule py-[10.2px]"
    >
      <p
        id={headingId}
        className="m-0 px-[20.4px] pb-0.5 pt-1.5 text-xs font-bold uppercase tracking-[0.1em] text-sd-neutral-700"
      >
        {t('console.userMenu.viewAsTitle')}
      </p>
      <p
        id={hintId}
        className="m-0 px-[20.4px] pb-2 text-[13.5px] leading-[1.4] text-sd-neutral-700"
      >
        {t('console.userMenu.viewAsHint')}
      </p>
      {roles.map((role) => {
        const shown = role.id === activeRoleId;
        return (
          <button
            key={role.id}
            type="button"
            aria-pressed={shown}
            onClick={() => {
              onViewAs(role.id);
              onPicked();
            }}
            className={`flex min-h-[46px] w-full items-center gap-3 px-[20.4px] py-1 text-left text-[15px] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sd-accent ${
              shown
                ? 'bg-sd-accent-100 font-semibold text-sd-accent-900'
                : 'text-sd-ink hover:bg-sd-neutral-200'
            }`}
          >
            <span
              aria-hidden="true"
              className={`size-[18px] shrink-0 rounded-full border-[1.5px] ${
                shown
                  ? 'border-sd-accent bg-sd-accent shadow-[inset_0_0_0_4px_var(--color-sd-paper)]'
                  : 'border-sd-neutral-600'
              }`}
            />
            <span className="min-w-0 flex-1">{role.label}</span>
            <span className="whitespace-nowrap text-[13px] font-normal tabular-nums text-sd-neutral-700">
              {role.pageCount === 1
                ? t('console.userMenu.pageCountOne')
                : t('console.userMenu.pageCount', { count: role.pageCount })}
            </span>
          </button>
        );
      })}
    </div>
  );
}
