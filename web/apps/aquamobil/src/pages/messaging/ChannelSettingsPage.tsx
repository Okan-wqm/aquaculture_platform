/**
 * ChannelSettingsPage -- Channel info, members, and settings management.
 *
 * WHY this design: Group channels need a central place to view members,
 * change notification preferences, add/remove members (for admins), and
 * leave or delete channels. This page follows the WhatsApp group info
 * pattern with sections for info, members, media, and danger zone actions.
 *
 * Role-based controls: ADMIN+ can edit channel name/description and add
 * members. Only the OWNER can delete the channel. Regular members can
 * change their notification preference and leave.
 */

import { useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Settings,
  Users,
  UserPlus,
  Bell,
  BellOff,
  BellRing,
  Image,
  Link,
  LogOut,
  Trash2,
  Crown,
  Shield,
  User,
  Edit3,
  ChevronRight,
  AlertCircle,
  X,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useAuth } from '@/hooks/useAuth';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ChannelRole = 'OWNER' | 'ADMIN' | 'MEMBER';
type NotificationPref = 'ALL' | 'MENTIONS' | 'NONE';

interface ChannelMember {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  isOnline: boolean;
  role: ChannelRole;
}

interface ChannelDetail {
  id: string;
  name: string;
  description: string;
  type: 'DM' | 'GROUP';
  avatarUrl: string | null;
  memberCount: number;
  members: ChannelMember[];
  myRole: ChannelRole;
  notificationPref: NotificationPref;
  createdAt: string;
  mediaCount: number;
  linkCount: number;
}

// ---------------------------------------------------------------------------
// TODO: Replace with real hooks once messaging backend is integrated
// import { useChannelDetail } from '@/hooks/useChannelDetail';
// import { useChannelActions } from '@/hooks/useChannelActions';
// ---------------------------------------------------------------------------

function useChannelDetail(_channelId: string): {
  channel: ChannelDetail | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
} {
  return {
    channel: null,
    loading: false,
    error: null,
    refetch: async () => {},
  };
}

function useChannelActions(_channelId: string): {
  updateNotificationPref: (pref: NotificationPref) => Promise<void>;
  leaveChannel: () => Promise<void>;
  deleteChannel: () => Promise<void>;
  isLoading: boolean;
} {
  return {
    updateNotificationPref: async () => {},
    leaveChannel: async () => {},
    deleteChannel: async () => {},
    isLoading: false,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return '?';
  const first = parts[0]?.charAt(0).toUpperCase() ?? '';
  const last =
    parts.length > 1
      ? (parts[parts.length - 1]?.charAt(0).toUpperCase() ?? '')
      : '';
  return first + last;
}

const ROLE_BADGES: Record<
  ChannelRole,
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

const NOTIFICATION_OPTIONS: Array<{
  value: NotificationPref;
  icon: typeof Bell;
  label: string;
  description: string;
}> = [
  {
    value: 'ALL',
    icon: BellRing,
    label: 'All Messages',
    description: 'Get notified for every message',
  },
  {
    value: 'MENTIONS',
    icon: Bell,
    label: 'Mentions Only',
    description: 'Only when you are mentioned',
  },
  {
    value: 'NONE',
    icon: BellOff,
    label: 'Muted',
    description: 'No notifications from this channel',
  },
];

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Confirmation dialog for destructive actions. */
function ConfirmDialog({
  title,
  message,
  confirmLabel,
  confirmColor,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  confirmColor?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-6">
      <div className="absolute inset-0 bg-black/50" onClick={onCancel} />
      <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-xl max-w-sm w-full p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
          {title}
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
          {message}
        </p>
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 font-medium text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`flex-1 py-2.5 rounded-xl ${confirmColor ?? 'bg-red-600'} text-white font-medium text-sm transition-colors`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Member row in the members list. */
function MemberRow({ member }: { member: ChannelMember }) {
  const roleBadge = ROLE_BADGES[member.role];
  const RoleIcon = roleBadge.icon;

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      {/* Avatar */}
      <div className="relative flex-shrink-0">
        {member.avatarUrl ? (
          <img
            src={member.avatarUrl}
            alt={member.name}
            className="w-10 h-10 rounded-full object-cover"
          />
        ) : (
          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-ocean-400 to-ocean-600 flex items-center justify-center text-xs font-bold text-white">
            {getInitials(member.name)}
          </div>
        )}
        {member.isOnline && (
          <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 border-2 border-white dark:border-gray-900 rounded-full" />
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white truncate">
          {member.name}
        </h3>
        <p className="text-xs text-gray-400 dark:text-gray-500 truncate">
          {member.email}
        </p>
      </div>

      {/* Role badge */}
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

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

/**
 * ChannelSettingsPage shows channel details, member list, notification
 * preferences, and channel management actions (leave, delete).
 */
export function ChannelSettingsPage() {
  const navigate = useNavigate();
  const { channelId } = useParams<{ channelId: string }>();
  const { user } = useAuth();

  const { channel, loading, error, refetch } = useChannelDetail(
    channelId ?? '',
  );
  const { updateNotificationPref, leaveChannel, deleteChannel, isLoading } =
    useChannelActions(channelId ?? '');

  const [showNotifPicker, setShowNotifPicker] = useState(false);
  const [showLeaveDialog, setShowLeaveDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const canEdit =
    channel?.myRole === 'OWNER' || channel?.myRole === 'ADMIN';
  const isOwner = channel?.myRole === 'OWNER';

  const handleNotifChange = useCallback(
    async (pref: NotificationPref) => {
      await updateNotificationPref(pref);
      setShowNotifPicker(false);
      await refetch();
    },
    [updateNotificationPref, refetch],
  );

  const handleLeave = useCallback(async () => {
    setShowLeaveDialog(false);
    await leaveChannel();
    navigate('/messages', { replace: true });
  }, [leaveChannel, navigate]);

  const handleDelete = useCallback(async () => {
    setShowDeleteDialog(false);
    await deleteChannel();
    navigate('/messages', { replace: true });
  }, [deleteChannel, navigate]);

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
        <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center gap-3 px-4 py-4 pt-safe-top">
            <button
              onClick={() => navigate(-1)}
              className="p-2 -ml-2 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 touch-feedback"
            >
              <ArrowLeft size={22} className="text-gray-700 dark:text-gray-300" />
            </button>
            <h1 className="text-lg font-bold text-gray-900 dark:text-white">
              Channel Info
            </h1>
          </div>
        </div>
        <div className="flex items-center justify-center min-h-[50vh]">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ocean-500" />
        </div>
      </div>
    );
  }

  // Error state
  if (error || !channel) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
        <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center gap-3 px-4 py-4 pt-safe-top">
            <button
              onClick={() => navigate(-1)}
              className="p-2 -ml-2 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 touch-feedback"
            >
              <ArrowLeft size={22} className="text-gray-700 dark:text-gray-300" />
            </button>
            <h1 className="text-lg font-bold text-gray-900 dark:text-white">
              Channel Info
            </h1>
          </div>
        </div>
        <div className="px-4 mt-4">
          <div className="bg-red-50 dark:bg-red-900/20 rounded-xl p-4 flex items-center gap-3 border border-red-200 dark:border-red-800">
            <AlertCircle size={20} className="text-red-500 flex-shrink-0" />
            <span className="text-red-600 dark:text-red-300 text-sm">
              {error || 'Channel not found'}
            </span>
          </div>
        </div>
      </div>
    );
  }

  const currentNotifOption = NOTIFICATION_OPTIONS.find(
    (o) => o.value === channel.notificationPref,
  );

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Header */}
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
        <div className="flex items-center gap-3 px-4 py-4 pt-safe-top">
          <button
            onClick={() => navigate(-1)}
            className="p-2 -ml-2 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 touch-feedback"
          >
            <ArrowLeft size={22} className="text-gray-700 dark:text-gray-300" />
          </button>
          <h1 className="text-lg font-bold text-gray-900 dark:text-white">
            Channel Info
          </h1>
        </div>
      </div>

      {/* Channel avatar + name */}
      <div className="flex flex-col items-center pt-6 pb-4 px-4">
        {/* Large avatar */}
        {channel.avatarUrl ? (
          <img
            src={channel.avatarUrl}
            alt={channel.name}
            className="w-20 h-20 rounded-full object-cover shadow-lg"
          />
        ) : (
          <div
            className={clsx(
              'w-20 h-20 rounded-full flex items-center justify-center text-2xl font-bold text-white shadow-lg',
              channel.type === 'GROUP'
                ? 'bg-gradient-to-br from-purple-400 to-purple-600'
                : 'bg-gradient-to-br from-ocean-400 to-ocean-600',
            )}
          >
            {channel.type === 'GROUP' ? (
              <Users size={32} />
            ) : (
              getInitials(channel.name)
            )}
          </div>
        )}

        {/* Channel name */}
        <div className="mt-3 text-center">
          <div className="flex items-center justify-center gap-2">
            <h2 className="text-lg font-bold text-gray-900 dark:text-white">
              {channel.name}
            </h2>
            {canEdit && channel.type === 'GROUP' && (
              <button className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 touch-feedback">
                <Edit3 size={14} className="text-gray-400" />
              </button>
            )}
          </div>
          {channel.type === 'GROUP' && (
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
              Group - {channel.memberCount} members
            </p>
          )}
          {channel.description && (
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-xs">
              {channel.description}
            </p>
          )}
        </div>
      </div>

      {/* Notifications section */}
      <div className="px-4 pt-2">
        <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider px-1 mb-2">
          Notifications
        </h3>
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card border border-gray-100 dark:border-gray-800 overflow-hidden">
          <button
            onClick={() => setShowNotifPicker(!showNotifPicker)}
            className="w-full flex items-center gap-3 p-4 touch-feedback transition-all"
          >
            <div className="w-10 h-10 rounded-xl bg-amber-50 dark:bg-amber-900/30 flex items-center justify-center">
              {currentNotifOption ? (
                <currentNotifOption.icon
                  size={20}
                  className="text-amber-600"
                />
              ) : (
                <Bell size={20} className="text-amber-600" />
              )}
            </div>
            <div className="flex-1 text-left min-w-0">
              <span className="font-medium text-gray-900 dark:text-white">
                {currentNotifOption?.label ?? 'All Messages'}
              </span>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                {currentNotifOption?.description ?? ''}
              </p>
            </div>
            <ChevronRight
              size={18}
              className={clsx(
                'text-gray-300 dark:text-gray-600 transition-transform',
                showNotifPicker && 'rotate-90',
              )}
            />
          </button>

          {/* Notification options picker */}
          {showNotifPicker && (
            <div className="border-t border-gray-100 dark:border-gray-800">
              {NOTIFICATION_OPTIONS.map((option) => {
                const OptIcon = option.icon;
                const isSelected =
                  channel.notificationPref === option.value;
                return (
                  <button
                    key={option.value}
                    onClick={() => handleNotifChange(option.value)}
                    className="w-full flex items-center gap-3 px-4 py-3.5 touch-feedback transition-all border-b border-gray-50 dark:border-gray-800 last:border-0"
                  >
                    <OptIcon
                      size={18}
                      className={
                        isSelected
                          ? 'text-ocean-500'
                          : 'text-gray-400 dark:text-gray-500'
                      }
                    />
                    <div className="flex-1 text-left">
                      <span
                        className={clsx(
                          'text-sm',
                          isSelected
                            ? 'font-semibold text-ocean-600 dark:text-ocean-400'
                            : 'font-medium text-gray-700 dark:text-gray-300',
                        )}
                      >
                        {option.label}
                      </span>
                    </div>
                    {isSelected && (
                      <div className="w-5 h-5 bg-ocean-500 rounded-full flex items-center justify-center">
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="white"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Members section */}
      {channel.type === 'GROUP' && (
        <div className="px-4 pt-6">
          <div className="flex items-center justify-between px-1 mb-2">
            <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Members ({channel.memberCount})
            </h3>
            {canEdit && (
              <button className="flex items-center gap-1 text-xs text-ocean-500 font-medium touch-feedback">
                <UserPlus size={14} />
                Add
              </button>
            )}
          </div>
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card border border-gray-100 dark:border-gray-800 overflow-hidden divide-y divide-gray-50 dark:divide-gray-800">
            {channel.members.map((member) => (
              <MemberRow key={member.id} member={member} />
            ))}
          </div>
        </div>
      )}

      {/* Media & Links section */}
      <div className="px-4 pt-6">
        <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider px-1 mb-2">
          Shared Content
        </h3>
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card border border-gray-100 dark:border-gray-800 overflow-hidden">
          <button className="w-full flex items-center gap-3 p-4 touch-feedback transition-all border-b border-gray-50 dark:border-gray-800">
            <div className="w-10 h-10 rounded-xl bg-purple-50 dark:bg-purple-900/30 flex items-center justify-center">
              <Image size={20} className="text-purple-600" />
            </div>
            <span className="font-medium text-gray-900 dark:text-white flex-1 text-left">
              Media
            </span>
            <span className="text-sm text-gray-400">{channel.mediaCount}</span>
            <ChevronRight
              size={18}
              className="text-gray-300 dark:text-gray-600"
            />
          </button>
          <button className="w-full flex items-center gap-3 p-4 touch-feedback transition-all">
            <div className="w-10 h-10 rounded-xl bg-green-50 dark:bg-green-900/30 flex items-center justify-center">
              <Link size={20} className="text-green-600" />
            </div>
            <span className="font-medium text-gray-900 dark:text-white flex-1 text-left">
              Shared Links
            </span>
            <span className="text-sm text-gray-400">{channel.linkCount}</span>
            <ChevronRight
              size={18}
              className="text-gray-300 dark:text-gray-600"
            />
          </button>
        </div>
      </div>

      {/* Danger zone */}
      <div className="px-4 pt-6">
        <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider px-1 mb-2">
          Actions
        </h3>
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card border border-gray-100 dark:border-gray-800 overflow-hidden">
          {/* Leave channel */}
          <button
            onClick={() => setShowLeaveDialog(true)}
            disabled={isLoading}
            className="w-full flex items-center gap-3 p-4 touch-feedback transition-all border-b border-gray-50 dark:border-gray-800"
          >
            <div className="w-10 h-10 rounded-xl bg-red-50 dark:bg-red-900/30 flex items-center justify-center">
              <LogOut size={20} className="text-red-600" />
            </div>
            <span className="font-medium text-red-600 dark:text-red-400">
              Leave Channel
            </span>
          </button>

          {/* Delete channel — OWNER only */}
          {isOwner && (
            <button
              onClick={() => setShowDeleteDialog(true)}
              disabled={isLoading}
              className="w-full flex items-center gap-3 p-4 touch-feedback transition-all"
            >
              <div className="w-10 h-10 rounded-xl bg-red-50 dark:bg-red-900/30 flex items-center justify-center">
                <Trash2 size={20} className="text-red-600" />
              </div>
              <span className="font-medium text-red-600 dark:text-red-400">
                Delete Channel
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Bottom spacer */}
      <div className="h-24" />

      {/* Confirmation dialogs */}
      {showLeaveDialog && (
        <ConfirmDialog
          title="Leave Channel"
          message="Are you sure you want to leave this channel? You will no longer receive messages."
          confirmLabel="Leave"
          confirmColor="bg-red-600"
          onConfirm={handleLeave}
          onCancel={() => setShowLeaveDialog(false)}
        />
      )}

      {showDeleteDialog && (
        <ConfirmDialog
          title="Delete Channel"
          message="This will permanently delete the channel and all its messages for all members. This action cannot be undone."
          confirmLabel="Delete"
          confirmColor="bg-red-600"
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteDialog(false)}
        />
      )}
    </div>
  );
}
