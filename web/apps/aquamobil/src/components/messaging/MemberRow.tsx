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
//
// Privilege reads as a step up the emphasis ladder rather than as three
// unrelated hues: Owner takes the watch token (the one role whose actions are
// unrecoverable), Admin the accent, Member the plain surface. The MEMBER entry
// is never rendered (see the guard below) but stays for exhaustiveness.
const ROLE_BADGES: Record<ChannelMemberRole, { icon: typeof Crown; label: string; color: string }> =
  {
    OWNER: {
      icon: Crown,
      label: 'Owner',
      color: 'bg-warn-dim text-warn',
    },
    ADMIN: {
      icon: Shield,
      label: 'Admin',
      color: 'bg-acc-dim text-acc',
    },
    MEMBER: {
      icon: User,
      label: 'Member',
      color: 'bg-surface-2 text-ink-2',
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
          // The brand gradient becomes a flat accent: the token layer has one
          // accent value per theme and no gradient pair, and a two-stop gradient
          // built from the same variable would just BE the flat colour.
          <div className="w-10 h-10 rounded-full bg-acc flex items-center justify-center text-meta font-bold text-acc-on">
            {getInitials(memberName)}
          </div>
        )}
        {memberOnline && (
          <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-ok border-2 border-surface-1 rounded-full" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <h3 className="text-body font-semibold text-ink-1 truncate">{memberName}</h3>
      </div>

      {member.role !== 'MEMBER' && (
        <span
          className={clsx(
            'flex items-center gap-1 text-meta font-semibold px-2 py-0.5 rounded-full',
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
