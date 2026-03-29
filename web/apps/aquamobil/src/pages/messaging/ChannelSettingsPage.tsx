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

import { useState, useCallback, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
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
import { clsx } from 'clsx';
import { useAuth } from '@/hooks/useAuth';
import { useChannelDetail } from '@/hooks/useChannelDetail';
import { useChannelActions } from '@/hooks/useChannelActions';
import { ChannelAvatar } from '@/components/messaging/ChannelAvatar';
import { ConfirmDialog } from '@/components/messaging/ConfirmDialog';
import { MemberRow } from '@/components/messaging/MemberRow';
import { SentimentBadge } from '@/components/messaging/SentimentBadge';
import { useAiConsent } from '@/hooks/useAiConsent';
import type { NotificationPreference } from '@/types/messaging';
import type { SentimentTrend } from '@/components/messaging/SentimentBadge';

const NOTIFICATION_OPTIONS: Array<{
  value: NotificationPreference;
  icon: typeof Bell;
  label: string;
  description: string;
}> = [
  {
    value: 'all',
    icon: BellRing,
    label: 'All Messages',
    description: 'Get notified for every message',
  },
  {
    value: 'mentions',
    icon: Bell,
    label: 'Mentions Only',
    description: 'Only when you are mentioned',
  },
  {
    value: 'none',
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
export function ChannelSettingsPage() {
  const navigate = useNavigate();
  const { channelId } = useParams<{ channelId: string }>();
  const { user } = useAuth();

  const { channel, isLoading: loading, error: queryError, refetch } =
    useChannelDetail(channelId);
  const {
    updateNotificationPref,
    leaveChannel,
    archiveChannel,
    isLoading: actionLoading,
  } = useChannelActions(channelId);

  const [showNotifPicker, setShowNotifPicker] = useState(false);
  const [showLeaveDialog, setShowLeaveDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

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

  const myRole = myMembership?.role ?? 'member';
  const canEdit = myRole === 'owner' || myRole === 'admin';
  const isOwner = myRole === 'owner';
  const isTenantAdmin = user?.role === 'TENANT_ADMIN';

  // Sentiment trend (TODO: fetch from backend when AI analysis is live)
  const sentimentTrend: SentimentTrend = 'neutral';

  // Current notification preference
  const myNotifPref = myMembership?.notificationPreference ?? 'all';

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

  // Active members (not left)
  const activeMembers = useMemo(() => {
    return (channel?.members ?? []).filter((m) => m.leftAt === null);
  }, [channel?.members]);

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
      {channel.type === 'group' && (
        <div className="px-4 pt-6">
          <div className="flex items-center justify-between px-1 mb-2">
            <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Members ({activeMembers.length})
            </h3>
            {canEdit && (
              <button className="flex items-center gap-1 text-xs text-ocean-500 font-medium touch-feedback">
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
