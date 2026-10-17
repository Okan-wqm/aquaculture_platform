/**
 * The company dashboard for a member who is not a tenant admin.
 *
 * WHAT: the member's notices — their unread messages, the users card for a
 * delegate holding users:view (the one account card a capability opens), and
 * the platform's announcements, which members cannot read yet
 * (RBAC-MEDIUM-021) and which therefore render as a labelled preview. No
 * account card meant for an admin (modules, billing and subscription,
 * sessions) is drawn, and none of their queries is sent.
 */
import {
  MockPreview,
  PageHeader,
  hasResourcePermission,
  useAuthContext,
  useI18n,
} from '@aquaculture/shared-ui';
import { ArrowRight, Megaphone, MessageSquare, Users } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { useTenantUsers } from '../../hooks/useTenantData';
import { useUnreadMessageCount } from '../../hooks/useUnreadMessageCount';

import { MEMBER_ANNOUNCEMENTS_PREVIEW } from './announcements.preview';

function NoticeLink({ to, label }: { readonly to: string; readonly label: string }): ReactElement {
  return (
    <Link
      to={to}
      className="inline-flex min-h-10 items-center gap-1.5 text-base font-medium text-sd-accent-700 hover:underline"
    >
      {label}
      <ArrowRight className="size-4" aria-hidden="true" />
    </Link>
  );
}

function Notice({
  icon,
  title,
  detail,
  action,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly detail?: string;
  readonly action?: ReactNode;
}): ReactElement {
  return (
    <li className="flex items-start gap-4 border-b border-sd-rule px-6 py-3.5">
      <span className="mt-1 shrink-0 text-sd-neutral-800">{icon}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-base leading-snug font-medium text-sd-ink">{title}</span>
        {detail !== undefined && <span className="text-sm text-sd-neutral-800">{detail}</span>}
      </div>
      {action}
    </li>
  );
}

function UsersNotice(): ReactElement | null {
  const { t } = useI18n();
  const users = useTenantUsers();
  if (users.data === undefined) return null;
  const active = users.data.filter((user) => user.isActive).length;
  return (
    <Notice
      icon={<Users className="size-4" aria-hidden="true" />}
      title={t('tenant.memberHome.users.title')}
      detail={t('tenant.memberHome.users.detail', { active, total: users.data.length })}
      action={<NoticeLink to="/tenant/users" label={t('tenant.memberHome.users.cta')} />}
    />
  );
}

export default function MemberCompanyHome(): ReactElement {
  const { t } = useI18n();
  const { user } = useAuthContext();
  const unread = useUnreadMessageCount();
  const canViewUsers = hasResourcePermission(user, 'users:view');
  const unreadCount = unread.data ?? 0;

  return (
    <div className="sd-page sd-stack">
      <PageHeader
        title={t('nav.page.companyDashboard')}
        description={t('tenant.memberHome.description')}
      />
      <section aria-labelledby="member-notices" className="sd-card flex min-w-0 flex-col">
        <h2
          id="member-notices"
          className="m-0 border-b border-sd-rule px-6 py-4 font-display-sd text-2xl font-semibold text-sd-ink"
        >
          {t('tenant.memberHome.notices')}
        </h2>
        <ul className="m-0 list-none p-0">
          {unreadCount > 0 && (
            <Notice
              icon={<MessageSquare className="size-4" aria-hidden="true" />}
              title={t(
                unreadCount === 1
                  ? 'tenant.memberHome.unread.one'
                  : 'tenant.memberHome.unread.other',
                {
                  count: unreadCount,
                },
              )}
              action={<NoticeLink to="/messaging" label={t('tenant.memberHome.unread.cta')} />}
            />
          )}
          {canViewUsers && <UsersNotice />}
        </ul>
        {unread.isSuccess && unreadCount === 0 && !canViewUsers && (
          <p className="m-0 px-6 py-4 text-base text-sd-neutral-800">
            {t('tenant.memberHome.empty')}
          </p>
        )}
        <MockPreview data={MEMBER_ANNOUNCEMENTS_PREVIEW} variant="block">
          {(announcement) => (
            <ul className="m-0 list-none p-0">
              <Notice
                icon={<Megaphone className="size-4" aria-hidden="true" />}
                title={`${t('tenant.memberHome.announcements.title')}: ${announcement.title}`}
                detail={announcement.content}
              />
            </ul>
          )}
        </MockPreview>
      </section>
    </div>
  );
}
