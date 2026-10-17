/**
 * Inbox — what is waiting for the viewer (model/inbox for each rule; the
 * hooks fetch only what the viewer's role may read).
 *
 * WHAT: the seat limit about to be reached and the maintenance announcements
 * in force (tenant admin), privileged users without two-factor sign-in
 * (users:view), and the access requests to review (roles:view) — the last a
 * labelled preview, since no service records access requests
 * (RBAC-MEDIUM-020). Each item names what it is about and links to where it
 * is handled. A source still loading adds nothing; the empty line appears
 * only once every source the viewer reads has answered.
 */
import { MockPreview, useI18n } from '@aquaculture/shared-ui';
import { KeyRound, Megaphone, ShieldAlert, Users, type LucideIcon } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';

import { useInbox } from '../hooks/useInbox';
import { formatAge } from '../model/format';
import { maintenanceInForce, seatNotice, usersWithoutMfa } from '../model/inbox';
import { ACCESS_REQUESTS_PREVIEW } from '../preview/accessRequests.preview';

import { DashboardPanel } from './DashboardPanel';
import { PanelLink } from './PanelLink';

interface NoticeProps {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly detail?: string;
  readonly since?: string;
  readonly cta: { readonly to: string; readonly label: string };
}

function Notice({ icon: Icon, title, detail, since, cta }: NoticeProps): ReactElement {
  return (
    <li className="flex items-start gap-4 border-b border-sd-rule px-6 py-3.5">
      <Icon className="mt-1 size-4 shrink-0 text-sd-neutral-800" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-base leading-snug font-medium text-sd-ink">{title}</span>
        {detail !== undefined && (
          <span className="text-sm leading-normal text-sd-neutral-800">{detail}</span>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        {since !== undefined && (
          <span className="text-sm whitespace-nowrap text-sd-neutral-700">{since}</span>
        )}
        <PanelLink to={cta.to} label={cta.label} />
      </div>
    </li>
  );
}

export function InboxPanel({ now }: { readonly now: Date }): ReactElement {
  const { t, locale } = useI18n();
  const inbox = useInbox();
  const items: ReactNode[] = [];

  const seats = seatNotice(inbox.seats?.data ?? null);
  if (seats !== null) {
    items.push(
      <Notice
        key="seats"
        icon={Users}
        title={t('dashboard.inbox.seats.title')}
        detail={t('dashboard.inbox.seats.detail', {
          used: seats.used,
          max: seats.max,
          pending: seats.pending,
        })}
        cta={{ to: '/tenant/users', label: t('dashboard.inbox.seats.cta') }}
      />,
    );
  }

  const withoutMfa = usersWithoutMfa(inbox.users?.data ?? []);
  if (withoutMfa.length > 0) {
    items.push(
      <Notice
        key="mfa"
        icon={ShieldAlert}
        title={t(
          withoutMfa.length === 1
            ? 'dashboard.inbox.mfa.title.one'
            : 'dashboard.inbox.mfa.title.other',
          {
            count: withoutMfa.length,
          },
        )}
        detail={t('dashboard.inbox.mfa.detail', { names: withoutMfa.join(', ') })}
        cta={{ to: '/tenant/users', label: t('dashboard.inbox.mfa.cta') }}
      />,
    );
  }

  for (const announcement of maintenanceInForce(inbox.maintenance?.data ?? [], now)) {
    items.push(
      <Notice
        key={`maintenance-${announcement.id}`}
        icon={Megaphone}
        title={t('dashboard.inbox.maintenance.title', { title: announcement.title })}
        since={formatAge(new Date(announcement.publishAt ?? announcement.createdAt), now, locale)}
        cta={{ to: '/tenant/announcements', label: t('dashboard.inbox.maintenance.cta') }}
      />,
    );
  }

  if (inbox.reviewsAccess) {
    items.push(
      <li key="access" className="list-none">
        <MockPreview data={ACCESS_REQUESTS_PREVIEW} variant="block">
          {(sample) => (
            <ul className="m-0 p-0">
              <Notice
                icon={KeyRound}
                title={t('dashboard.inbox.access.title', { count: sample.count })}
                detail={t('dashboard.inbox.access.detail', {
                  names: sample.names,
                  capability: sample.capability,
                  site: sample.site,
                })}
                cta={{ to: '/tenant/roles', label: t('dashboard.inbox.access.cta') }}
              />
            </ul>
          )}
        </MockPreview>
      </li>,
    );
  }

  const sources = [inbox.seats, inbox.users, inbox.maintenance].filter((source) => source !== null);
  const settled = sources.every((source) => source.isSuccess || source.isError);

  let body: ReactNode;
  if (items.length > 0) {
    body = <ul className="m-0 list-none p-0">{items}</ul>;
  } else if (settled) {
    body = <p className="m-0 p-6 text-base text-sd-neutral-800">{t('dashboard.inbox.empty')}</p>;
  } else {
    body = <span aria-hidden="true" className="m-6 block h-12 animate-pulse bg-sd-neutral-200" />;
  }

  return (
    <DashboardPanel
      headingId="dashboard-inbox"
      title={t('dashboard.inbox.title')}
      status={t('dashboard.inbox.subtitle')}
    >
      {body}
    </DashboardPanel>
  );
}
