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

import { clsx } from 'clsx';
import {
  ArrowLeft,
  UserPlus,
  Bell,
  BellOff,
  BellRing,
  Image,
  Link,
  LogOut,
  Trash2,
  Edit3,
  ChevronRight,
  AlertCircle,
  Brain,
  Sparkles,
} from 'lucide-react';
import { useState, useCallback, useMemo, type JSX } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { ChannelAvatar } from '@/components/messaging/ChannelAvatar';
import { ConfirmDialog } from '@/components/messaging/ConfirmDialog';
import { MemberRow } from '@/components/messaging/MemberRow';
import { SentimentBadge } from '@/components/messaging/SentimentBadge';
import type { SentimentTrend } from '@/components/messaging/SentimentBadge';
import { useAiConsent } from '@/hooks/useAiConsent';
import { useAuth } from '@/hooks/useAuth';
import { useChannelActions } from '@/hooks/useChannelActions';
import { useChannelDetail } from '@/hooks/useChannelDetail';
import { useTenantUsers } from '@/hooks/useTenantUsers';
import type { NotificationPreference } from '@/types/messaging';

const NOTIFICATION_OPTIONS: Array<{
  value: NotificationPreference;
  icon: typeof Bell;
  label: string;
  description: string;
}> = [
  {
    // S1-CODEGEN: NotificationPreference wire form is the UPPERCASE GraphQL enum NAME.
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
// Main Component
// ---------------------------------------------------------------------------

/**
 * ChannelSettingsPage shows channel details, member list, notification
 * preferences, and channel management actions (leave, delete).
 */
export function ChannelSettingsPage(): JSX.Element {
  const navigate = useNavigate();
  const { channelId } = useParams<{ channelId: string }>();
  const { user } = useAuth();

  const { channel, isLoading: loading, error: queryError, refetch } =
    useChannelDetail(channelId);
  const {
    updateNotificationPref,
    leaveChannel,
    archiveChannel,
    addMember,
    isLoading: actionLoading,
  } = useChannelActions(channelId);

  const { users: tenantUsers } = useTenantUsers();

  const [showNotifPicker, setShowNotifPicker] = useState(false);
  const [showLeaveDialog, setShowLeaveDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showAddMemberSheet, setShowAddMemberSheet] = useState(false);
  const [addMemberSearch, setAddMemberSearch] = useState('');

  // AI consent hook
  const {
    isAiEnabled,
    hasConsented,
    toggleConsent,
    isLoading: aiConsentLoading,
  } = useAiConsent();

  // Determine current user's role in this channel
  const myMembership = useMemo(() => {
    if (!channel?.members || !user?.id) return null;
    return channel.members.find((m) => m.userId === user.id) ?? null;
  }, [channel?.members, user?.id]);

  // S1-CODEGEN: ChannelMemberRole wire form is the UPPERCASE GraphQL enum NAME.
  const myRole = myMembership?.role ?? 'MEMBER';
  const canEdit = myRole === 'OWNER' || myRole === 'ADMIN';
  const isOwner = myRole === 'OWNER';
  const isTenantAdmin = user?.role === 'TENANT_ADMIN';

  // Sentiment trend (TODO: fetch from backend when AI analysis is live)
  const sentimentTrend: SentimentTrend = 'neutral';

  // Current notification preference (UPPERCASE GraphQL enum NAME wire form).
  const myNotifPref = myMembership?.notificationPreference ?? 'ALL';

  const handleNotifChange = useCallback(
    async (pref: NotificationPreference) => {
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
    await archiveChannel();
    navigate('/messages', { replace: true });
  }, [archiveChannel, navigate]);

  const error = queryError
    ? (queryError instanceof Error ? queryError.message : 'Failed to load channel')
    : null;

  /** Add a user to the channel and close the add-member sheet. */
  const handleAddMember = useCallback(
    async (userId: string) => {
      await addMember(userId);
      setShowAddMemberSheet(false);
      setAddMemberSearch('');
      await refetch();
    },
    [addMember, refetch],
  );

  // Active members (not left)
  const activeMembers = useMemo(() => {
    return (channel?.members ?? []).filter((m) => m.leftAt === null);
  }, [channel?.members]);

  /** Tenant users who are NOT already members of this channel. */
  const availableUsers = useMemo(() => {
    const memberIds = new Set(activeMembers.map((m) => m.userId));
    const filtered = tenantUsers.filter((u) => !memberIds.has(u.id));
    if (!addMemberSearch.trim()) return filtered;
    const query = addMemberSearch.toLowerCase();
    return filtered.filter(
      (u) =>
        u.name.toLowerCase().includes(query) ||
        u.email.toLowerCase().includes(query),
    );
  }, [tenantUsers, activeMembers, addMemberSearch]);

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

  const displayName = channel.name ?? 'Unnamed Channel';
  const avatarType = channel.type === 'direct' ? 'dm' : channel.type === 'ai' ? 'ai' : 'group';
  const currentNotifOption = NOTIFICATION_OPTIONS.find((o) => o.value === myNotifPref);

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
        <ChannelAvatar
          type={avatarType}
          name={displayName}
          imageUrl={channel.avatarUrl ?? undefined}
          size="xl"
        />

        <div className="mt-3 text-center">
          <div className="flex items-center justify-center gap-2">
            <h2 className="text-lg font-bold text-gray-900 dark:text-white">
              {displayName}
            </h2>
            {canEdit && channel.type === 'group' && (
              <button className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 touch-feedback">
                <Edit3 size={14} className="text-gray-400" />
              </button>
            )}
          </div>
          {channel.type === 'group' && (
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
              Group - {channel.memberCount ?? activeMembers.length} members
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
                <currentNotifOption.icon size={20} className="text-amber-600" />
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

          {showNotifPicker && (
            <div className="border-t border-gray-100 dark:border-gray-800">
              {NOTIFICATION_OPTIONS.map((option) => {
                const OptIcon = option.icon;
                const isSelected = myNotifPref === option.value;
                return (
                  <button
                    key={option.value}
                    onClick={() => { void handleNotifChange(option.value); }}
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
      {channel.type === 'group' && (
        <div className="px-4 pt-6">
          <div className="flex items-center justify-between px-1 mb-2">
            <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Members ({activeMembers.length})
            </h3>
            {canEdit && (
              <button
                onClick={() => setShowAddMemberSheet(true)}
                className="flex items-center gap-1 text-xs text-ocean-500 font-medium touch-feedback"
              >
                <UserPlus size={14} />
                Add
              </button>
            )}
          </div>
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card border border-gray-100 dark:border-gray-800 overflow-hidden divide-y divide-gray-50 dark:divide-gray-800">
            {activeMembers.map((member) => (
              <MemberRow key={member.id} member={member} />
            ))}
          </div>
        </div>
      )}

      {/* AI Analysis section (TENANT_ADMIN only) */}
      {isTenantAdmin && (
        <div className="px-4 pt-6">
          <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider px-1 mb-2">
            AI Analysis
          </h3>
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card border border-gray-100 dark:border-gray-800 overflow-hidden">
            {/* AI Analysis Toggle */}
            <div className="flex items-center justify-between p-4 border-b border-gray-50 dark:border-gray-800">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-purple-50 dark:bg-purple-900/30 flex items-center justify-center">
                  <Brain size={20} className="text-purple-600" />
                </div>
                <div>
                  <span className="font-medium text-gray-900 dark:text-white">
                    AI Analysis
                  </span>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {isAiEnabled ? 'Enabled for this tenant' : 'Not enabled for tenant'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => void toggleConsent()}
                disabled={!isAiEnabled || aiConsentLoading}
                className={clsx(
                  'relative w-12 h-7 rounded-full transition-colors duration-200 flex-shrink-0',
                  hasConsented && isAiEnabled
                    ? 'bg-purple-500'
                    : 'bg-gray-200 dark:bg-gray-700',
                  (!isAiEnabled || aiConsentLoading) && 'opacity-50 cursor-not-allowed',
                )}
              >
                <span
                  className={clsx(
                    'absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow-sm transition-transform duration-200',
                    hasConsented && isAiEnabled && 'translate-x-5',
                  )}
                />
              </button>
            </div>

            {/* Consent Status */}
            <div className="px-4 py-3 border-b border-gray-50 dark:border-gray-800">
              <div className="flex items-center gap-2">
                <Sparkles size={14} className="text-gray-400" />
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  Consent: {hasConsented ? 'Granted' : 'Not granted'}
                </span>
              </div>
            </div>

            {/* Sentiment Badge (only if analysis enabled) */}
            {isAiEnabled && hasConsented && (
              <div className="px-4 py-3 flex items-center justify-between">
                <span className="text-sm text-gray-600 dark:text-gray-300">
                  Weekly Sentiment
                </span>
                <SentimentBadge trend={sentimentTrend} />
              </div>
            )}
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
            <ChevronRight size={18} className="text-gray-300 dark:text-gray-600" />
          </button>
          <button className="w-full flex items-center gap-3 p-4 touch-feedback transition-all">
            <div className="w-10 h-10 rounded-xl bg-green-50 dark:bg-green-900/30 flex items-center justify-center">
              <Link size={20} className="text-green-600" />
            </div>
            <span className="font-medium text-gray-900 dark:text-white flex-1 text-left">
              Shared Links
            </span>
            <ChevronRight size={18} className="text-gray-300 dark:text-gray-600" />
          </button>
        </div>
      </div>

      {/* Danger zone */}
      <div className="px-4 pt-6">
        <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider px-1 mb-2">
          Actions
        </h3>
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card border border-gray-100 dark:border-gray-800 overflow-hidden">
          <button
            onClick={() => setShowLeaveDialog(true)}
            disabled={actionLoading}
            className="w-full flex items-center gap-3 p-4 touch-feedback transition-all border-b border-gray-50 dark:border-gray-800"
          >
            <div className="w-10 h-10 rounded-xl bg-red-50 dark:bg-red-900/30 flex items-center justify-center">
              <LogOut size={20} className="text-red-600" />
            </div>
            <span className="font-medium text-red-600 dark:text-red-400">
              Leave Channel
            </span>
          </button>

          {isOwner && (
            <button
              onClick={() => setShowDeleteDialog(true)}
              disabled={actionLoading}
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
          onConfirm={() => { void handleLeave(); }}
          onCancel={() => setShowLeaveDialog(false)}
        />
      )}

      {showDeleteDialog && (
        <ConfirmDialog
          title="Delete Channel"
          message="This will permanently delete the channel and all its messages for all members. This action cannot be undone."
          confirmLabel="Delete"
          confirmColor="bg-red-600"
          onConfirm={() => { void handleDelete(); }}
          onCancel={() => setShowDeleteDialog(false)}
        />
      )}

      {/* Add Member bottom sheet */}
      {showAddMemberSheet && (
        <div className="fixed inset-0 z-50 flex items-end justify-center" role="dialog" aria-modal="true">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => {
              setShowAddMemberSheet(false);
              setAddMemberSearch('');
            }}
            aria-hidden="true"
          />
          <div className="relative w-full max-w-lg bg-white dark:bg-gray-900 rounded-t-3xl shadow-elevated pb-safe max-h-[70vh] flex flex-col">
            {/* Handle bar */}
            <div className="flex justify-center pt-3 pb-2 flex-shrink-0">
              <div className="w-10 h-1 bg-gray-300 dark:bg-gray-700 rounded-full" />
            </div>

            {/* Header */}
            <div className="flex items-center justify-between px-5 pb-3 flex-shrink-0">
              <h3 className="text-base font-bold text-gray-900 dark:text-white">
                Add Member
              </h3>
              <button
                onClick={() => {
                  setShowAddMemberSheet(false);
                  setAddMemberSearch('');
                }}
                className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 touch-feedback"
                aria-label="Close"
              >
                <span className="text-gray-500 text-lg">&times;</span>
              </button>
            </div>

            {/* Search input */}
            <div className="px-5 pb-3 flex-shrink-0">
              <input
                type="text"
                value={addMemberSearch}
                onChange={(e) => setAddMemberSearch(e.target.value)}
                placeholder="Search by name or email..."
                className="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-4 py-2.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-ocean-500/40 focus:border-ocean-500"
              />
            </div>

            {/* User list */}
            <div className="overflow-y-auto flex-1 px-5 pb-4">
              {availableUsers.length === 0 ? (
                <p className="text-center text-sm text-gray-400 py-6">
                  {addMemberSearch ? 'No users match your search' : 'All users are already members'}
                </p>
              ) : (
                <div className="space-y-1">
                  {availableUsers.map((u) => (
                    <button
                      key={u.id}
                      onClick={() => { void handleAddMember(u.id); }}
                      disabled={actionLoading}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-gray-50 dark:hover:bg-gray-800 touch-feedback transition-colors"
                    >
                      <div className="w-10 h-10 rounded-full bg-ocean-100 dark:bg-ocean-900/30 flex items-center justify-center flex-shrink-0">
                        <span className="text-sm font-bold text-ocean-600 dark:text-ocean-400">
                          {u.name.charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <div className="flex-1 text-left min-w-0">
                        <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                          {u.name}
                        </p>
                        <p className="text-xs text-gray-400 dark:text-gray-500 truncate">
                          {u.email}
                        </p>
                      </div>
                      {u.isOnline && (
                        <div className="w-2.5 h-2.5 rounded-full bg-green-500 flex-shrink-0" />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
