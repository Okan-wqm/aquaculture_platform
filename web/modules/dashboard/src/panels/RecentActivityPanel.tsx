/**
 * Recent activity — the tenant's latest audit entries, for a tenant admin only
 * (the design's isAdmin gate, and tenantAuditLogs' own). For anyone else the
 * panel is not drawn and nothing is requested.
 */
import { useI18n } from '@aquaculture/shared-ui';
import type { ReactElement } from 'react';

import { useRecentAudit, type AuditEntry } from '../hooks/useRecentAudit';
import { formatAge } from '../model/format';

import { DashboardPanel } from './DashboardPanel';
import { PanelLink } from './PanelLink';

/** Who did it: the actor's e-mail where the audit kept one, else their id. */
export function actorOf(entry: Pick<AuditEntry, 'performedBy' | 'performedByEmail'>): string {
  return entry.performedByEmail ?? entry.performedBy;
}

/** Two letters for the actor's mark: the e-mail's local part, else the id's start. */
export function initialsOf(actor: string): string {
  const local = actor.split('@')[0] ?? actor;
  const parts = local.split(/[._-]+/).filter((part) => part !== '');
  const letters =
    parts.length > 1 ? `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}` : local.slice(0, 2);
  return letters.toUpperCase();
}

export function RecentActivityPanel({ now }: { readonly now: Date }): ReactElement | null {
  const { t, locale } = useI18n();
  const audit = useRecentAudit();
  if (audit === null) return null;

  return (
    <DashboardPanel
      headingId="dashboard-activity"
      title={t('dashboard.activity.title')}
      action={<PanelLink to="/tenant/audit-log" label={t('dashboard.activity.openAudit')} />}
    >
      {audit.isError ? (
        <p role="alert" className="m-0 p-6 text-base text-sd-neutral-800">
          {t('dashboard.activity.loadError')}
        </p>
      ) : audit.data === undefined ? (
        <span aria-hidden="true" className="m-6 block h-12 animate-pulse bg-sd-neutral-200" />
      ) : audit.data.length === 0 ? (
        <p className="m-0 p-6 text-base text-sd-neutral-800">{t('dashboard.activity.empty')}</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {audit.data.map((entry) => {
            const actor = actorOf(entry);
            return (
              <li
                key={entry.id}
                className="flex items-start gap-4 border-b border-sd-rule px-6 py-3.5"
              >
                <span
                  aria-hidden="true"
                  className="grid size-9 shrink-0 place-items-center border border-sd-rule font-display-sd text-sm font-semibold text-sd-accent-800"
                >
                  {initialsOf(actor)}
                </span>
                <span className="min-w-0 flex-1 text-base leading-normal">
                  <span className="font-medium text-sd-ink">{actor}</span>{' '}
                  <span className="text-sd-neutral-800">
                    {t('dashboard.activity.entry', {
                      action: entry.action,
                      entity: entry.entityType,
                    })}
                  </span>
                </span>
                <span className="shrink-0 text-sm whitespace-nowrap text-sd-neutral-700">
                  {formatAge(new Date(entry.createdAt), now, locale)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </DashboardPanel>
  );
}
