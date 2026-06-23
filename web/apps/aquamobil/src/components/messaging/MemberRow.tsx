/**
 * @module MemberRow
 * @description Single member row for channel member lists. Renders avatar,
 * display name, email, online indicator, and role badge (Owner/Admin/Member).
 * @see ADR-012 section 3 (Channel domain)
 */

import { clsx } from 'clsx';
import { Crown, Shield, User } from 'lucide-react';
import type { ReactElement } from 'react';

import type { ChannelMember, ChannelMemberRole } from '@/types/messaging';
import { getInitials, getUserDisplayName } from '@/utils/messaging-helpers';

/**
 * WHY: Extracted from ChannelSettingsPage to reduce file size and enable
 * reuse in "Add Members" flow and member management screens.
 */

// S1-CODEGEN: ChannelMemberRole wire form is the UPPERCASE GraphQL enum NAME.
const ROLE_BADGES: Record<
  ChannelMemberRole,
  { icon: typeof Crown; label: string; color: string }
> = {
  OWNER: {
    icon: Crown,
    label: 'Owner',
    color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  },
  ADMIN: {
    icon: Shield,
    label: 'Admin',
    color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  },
  MEMBER: {
    icon: User,
    label: 'Member',
    color: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  },
};

interface MemberRowProps {
  /** The channel member to display. */
  member: ChannelMember;
}

/**
 * MemberRow displays a single channel member with avatar, name, email,
 * online indicator, and role badge.
 */
export function MemberRow({ member }: MemberRowProps): ReactElement {
  const roleBadge = ROLE_BADGES[member.role];
  const RoleIcon = roleBadge.icon;
  const memberName = member.user ? getUserDisplayName(member.user) : 'Unknown User';
  const memberEmail = member.user?.email ?? '';
  const memberAvatar = member.user?.profileImageUrl ?? member.user?.avatarUrl ?? null;
  const memberOnline = member.user?.isOnline ?? false;

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="relative flex-shrink-0">
        {memberAvatar ? (
          <img
            src={memberAvatar}
            alt={memberName}
            className="w-10 h-10 rounded-full object-cover"
          />
        ) : (
          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-ocean-400 to-ocean-600 flex items-center justify-center text-xs font-bold text-white">
            {getInitials(memberName)}
          </div>
        )}
        {memberOnline && (
          <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 border-2 border-white dark:border-gray-900 rounded-full" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white truncate">
          {memberName}
        </h3>
        <p className="text-xs text-gray-400 dark:text-gray-500 truncate">
          {memberEmail}
        </p>
      </div>

      {member.role !== 'MEMBER' && (
        <span
          className={clsx(
            'flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full',
            roleBadge.color,
          )}
        >
          <RoleIcon size={10} />
          {roleBadge.label}
        </span>
      )}
    </div>
  );
}
