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
  AlertCircle,
  Bell,
  BellOff,
  BellRing,
  Brain,
  Check,
  ChevronRight,
  Edit3,
  Image,
  Link,
  LogOut,
  Sparkles,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { useState, useCallback, useMemo, type JSX } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { AppHeader } from '@/components/AppHeader';
import { ChannelAvatar } from '@/components/messaging/ChannelAvatar';
import { MemberRow } from '@/components/messaging/MemberRow';
import { SentimentBadge } from '@/components/messaging/SentimentBadge';
import {
  BottomSheet,
  Button,
  Card,
  ConfirmSheet,
  EmptyState,
  IconButton,
  Skeleton,
  Switch,
} from '@/components/ui';
import { useAiConsent } from '@/hooks/useAiConsent';
import { useAuth } from '@/hooks/useAuth';
import { useChannelActions } from '@/hooks/useChannelActions';
import { useChannelDetail } from '@/hooks/useChannelDetail';
import { useSentimentTrends } from '@/hooks/useSentimentTrends';
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

  const { channel, isLoading: loading, error: queryError, refetch } = useChannelDetail(channelId);
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
  const closeAddMemberSheet = useCallback(() => {
    setShowAddMemberSheet(false);
    setAddMemberSearch('');
  }, []);

  // AI consent hook
  const { isAiEnabled, hasConsented, toggleConsent, isLoading: aiConsentLoading } = useAiConsent();

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

  // MOB-MEDIUM-003: real weekly sentiment from the messaging subgraph
  // (message_analyses aggregates). Fetch only when the badge could render —
  // tenant admin viewer, AI enabled, consent granted.
  const { latest: latestSentiment } = useSentimentTrends(
    channelId,
    isTenantAdmin && isAiEnabled && hasConsented,
  );

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
    ? queryError instanceof Error
      ? queryError.message
      : 'Failed to load channel'
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
      (u) => u.name.toLowerCase().includes(query) || u.email.toLowerCase().includes(query),
    );
  }, [tenantUsers, activeMembers, addMemberSearch]);

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen">
        <AppHeader title="Channel Info" onBack={() => navigate(-1)} showAvatar={false} />
        <div className="px-4">
          <Skeleton variant="tile" count={3} />
        </div>
      </div>
    );
  }

  // Error state
  if (error || !channel) {
    return (
      <div className="min-h-screen">
        <AppHeader title="Channel Info" onBack={() => navigate(-1)} showAvatar={false} />
        {/* tone="error" announces itself and takes the alarm tile, so a failed
            fetch cannot be mistaken for an empty channel. */}
        <EmptyState
          tone="error"
          icon={<AlertCircle size={22} />}
          title="Could not load channel"
          description={error || 'Channel not found'}
        />
      </div>
    );
  }

  const displayName = channel.name ?? 'Unnamed Channel';
  const avatarType = channel.type === 'direct' ? 'dm' : channel.type === 'ai' ? 'ai' : 'group';
  const currentNotifOption = NOTIFICATION_OPTIONS.find((o) => o.value === myNotifPref);

  return (
    // The page ground comes from <body>, so no background is set here.
    <div className="min-h-screen">
      <AppHeader title="Channel Info" onBack={() => navigate(-1)} showAvatar={false} />

      {/* Channel avatar + name */}
      <div className="flex flex-col items-center pt-2 pb-4 px-4">
        <ChannelAvatar
          type={avatarType}
          name={displayName}
          imageUrl={channel.avatarUrl ?? undefined}
          size="xl"
        />

        <div className="mt-3 text-center">
          <div className="flex items-center justify-center gap-2">
            <h2 className="text-head font-bold text-ink-1">{displayName}</h2>
            {canEdit && channel.type === 'group' && (
              // IconButton supplies the 44px floor and the accessible name this
              // icon-only control never had. It carries no handler today — that
              // is unchanged here; wiring it is not a restyle.
              <IconButton aria-label="Edit channel name" className="hover:bg-surface-2">
                <Edit3 size={14} className="text-ink-3" />
              </IconButton>
            )}
          </div>
          {channel.type === 'group' && (
            <p className="text-body text-ink-3 mt-0.5">
              Group - {channel.memberCount ?? activeMembers.length} members
            </p>
          )}
          {channel.description && (
            <p className="text-body text-ink-3 mt-1 max-w-xs">{channel.description}</p>
          )}
        </div>
      </div>

      {/* Notifications section */}
      <div className="px-4 pt-2">
        <h3 className="text-meta font-semibold text-ink-3 uppercase tracking-wider px-1 mb-2">
          Notifications
        </h3>
        <Card className="overflow-hidden">
          <button
            onClick={() => setShowNotifPicker(!showNotifPicker)}
            className="w-full flex items-center gap-3 p-4 min-h-touch touch-feedback transition-all"
          >
            {/* The accent, not amber: this tile shows the ACTIVE setting, and in
                v4 the accent carries every active state. Amber is reserved for a
                watch condition, which a notification preference is not. */}
            <div className="w-10 h-10 rounded-xl bg-acc-dim flex items-center justify-center">
              {currentNotifOption ? (
                <currentNotifOption.icon size={20} className="text-acc" />
              ) : (
                <Bell size={20} className="text-acc" />
              )}
            </div>
            <div className="flex-1 text-left min-w-0">
              <span className="text-title font-medium text-ink-1">
                {currentNotifOption?.label ?? 'All Messages'}
              </span>
              <p className="text-meta text-ink-3 mt-0.5">{currentNotifOption?.description ?? ''}</p>
            </div>
            <ChevronRight
              size={18}
              className={clsx('text-ink-3 transition-transform', showNotifPicker && 'rotate-90')}
            />
          </button>

          {showNotifPicker && (
            <div className="border-t border-line">
              {NOTIFICATION_OPTIONS.map((option) => {
                const OptIcon = option.icon;
                const isSelected = myNotifPref === option.value;
                return (
                  <button
                    key={option.value}
                    onClick={() => {
                      void handleNotifChange(option.value);
                    }}
                    className="w-full flex items-center gap-3 px-4 py-3.5 min-h-touch touch-feedback transition-all border-b border-line last:border-0"
                  >
                    <OptIcon size={18} className={isSelected ? 'text-acc' : 'text-ink-3'} />
                    <div className="flex-1 text-left">
                      <span
                        className={clsx(
                          'text-body',
                          isSelected ? 'font-semibold text-acc' : 'font-medium text-ink-2',
                        )}
                      >
                        {option.label}
                      </span>
                    </div>
                    {isSelected && (
                      // A lucide Check on the accent replaces the inline SVG with
                      // its hardcoded white stroke — `--on-acc` is the ink the
                      // theme puts on a saturated fill, and white is wrong on the
                      // day theme's lighter teal.
                      <div className="w-5 h-5 bg-acc rounded-full flex items-center justify-center">
                        <Check size={12} strokeWidth={3} className="text-acc-on" />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {/* Members section */}
      {channel.type === 'group' && (
        <div className="px-4 pt-6">
          <div className="flex items-center justify-between px-1 mb-2">
            <h3 className="text-meta font-semibold text-ink-3 uppercase tracking-wider">
              Members ({activeMembers.length})
            </h3>
            {canEdit && (
              <Button
                variant="ghost"
                onClick={() => setShowAddMemberSheet(true)}
                className="text-acc text-body px-2"
              >
                <UserPlus size={14} />
                Add
              </Button>
            )}
          </div>
          <Card className="overflow-hidden divide-y divide-line">
            {activeMembers.map((member) => (
              <MemberRow key={member.id} member={member} />
            ))}
          </Card>
        </div>
      )}

      {/* AI Analysis section (TENANT_ADMIN only) */}
      {isTenantAdmin && (
        <div className="px-4 pt-6">
          <h3 className="text-meta font-semibold text-ink-3 uppercase tracking-wider px-1 mb-2">
            AI Analysis
          </h3>
          <Card className="overflow-hidden">
            {/* AI Analysis Toggle */}
            <div className="flex items-center justify-between p-4 border-b border-line">
              <div className="flex items-center gap-3">
                {/* Teal rather than a violet of its own: there is no AI token,
                    and a hand-picked purple is the one colour no theme owns. */}
                <div className="w-10 h-10 rounded-xl bg-acc-dim flex items-center justify-center">
                  <Brain size={20} className="text-acc" />
                </div>
                <div>
                  <span className="text-title font-medium text-ink-1">AI Analysis</span>
                  <p className="text-meta text-ink-3 mt-0.5">
                    {isAiEnabled ? 'Enabled for this tenant' : 'Not enabled for tenant'}
                  </p>
                </div>
              </div>
              <Switch
                label="AI Analysis"
                hideLabel
                checked={hasConsented && isAiEnabled}
                onChange={() => void toggleConsent()}
                disabled={!isAiEnabled || aiConsentLoading}
              />
            </div>

            {/* Consent Status */}
            <div className="px-4 py-3 border-b border-line">
              <div className="flex items-center gap-2">
                <Sparkles size={14} className="text-ink-3" />
                <span className="text-meta text-ink-3">
                  Consent: {hasConsented ? 'Granted' : 'Not granted'}
                </span>
              </div>
            </div>

            {/* Sentiment Badge — TENANT_ADMIN only (matches the backend gate),
                and only when analysis rows actually exist. No rows → no badge,
                never a fabricated verdict (MOB-MEDIUM-003). */}
            {latestSentiment !== null && (
              <div className="px-4 py-3 flex items-center justify-between">
                <span className="text-body text-ink-2">Weekly Sentiment</span>
                <SentimentBadge trend={latestSentiment.badge} />
              </div>
            )}
          </Card>
        </div>
      )}

      {/* Media & Links section */}
      <div className="px-4 pt-6">
        <h3 className="text-meta font-semibold text-ink-3 uppercase tracking-wider px-1 mb-2">
          Shared Content
        </h3>
        <Card className="overflow-hidden">
          {/* Neutral tiles: these two rows are navigation, not status, and v4
              spends colour only on state or on a log type. */}
          <button className="w-full flex items-center gap-3 p-4 min-h-touch touch-feedback transition-all border-b border-line">
            <div className="w-10 h-10 rounded-xl bg-surface-2 flex items-center justify-center">
              <Image size={20} className="text-ink-2" />
            </div>
            <span className="text-title font-medium text-ink-1 flex-1 text-left">Media</span>
            <ChevronRight size={18} className="text-ink-3" />
          </button>
          <button className="w-full flex items-center gap-3 p-4 min-h-touch touch-feedback transition-all">
            <div className="w-10 h-10 rounded-xl bg-surface-2 flex items-center justify-center">
              <Link size={20} className="text-ink-2" />
            </div>
            <span className="text-title font-medium text-ink-1 flex-1 text-left">Shared Links</span>
            <ChevronRight size={18} className="text-ink-3" />
          </button>
        </Card>
      </div>

      {/* Danger zone */}
      <div className="px-4 pt-6">
        <h3 className="text-meta font-semibold text-ink-3 uppercase tracking-wider px-1 mb-2">
          Actions
        </h3>
        <Card className="overflow-hidden">
          {/* Coral here IS an alarm, not decoration: both rows are irreversible
              from the worker's side, so they take the crit token. */}
          <button
            onClick={() => setShowLeaveDialog(true)}
            disabled={actionLoading}
            className="w-full flex items-center gap-3 p-4 min-h-touch touch-feedback transition-all border-b border-line"
          >
            <div className="w-10 h-10 rounded-xl bg-crit-dim flex items-center justify-center">
              <LogOut size={20} className="text-crit" />
            </div>
            <span className="text-title font-medium text-crit">Leave Channel</span>
          </button>

          {isOwner && (
            <button
              onClick={() => setShowDeleteDialog(true)}
              disabled={actionLoading}
              className="w-full flex items-center gap-3 p-4 min-h-touch touch-feedback transition-all"
            >
              <div className="w-10 h-10 rounded-xl bg-crit-dim flex items-center justify-center">
                <Trash2 size={20} className="text-crit" />
              </div>
              <span className="text-title font-medium text-crit">Delete Channel</span>
            </button>
          )}
        </Card>
      </div>

      {/* Confirmation sheets */}
      <ConfirmSheet
        isOpen={showLeaveDialog}
        title="Leave Channel"
        message="Are you sure you want to leave this channel? You will no longer receive messages."
        confirmLabel="Leave"
        onConfirm={handleLeave}
        onCancel={() => setShowLeaveDialog(false)}
      />

      <ConfirmSheet
        isOpen={showDeleteDialog}
        title="Delete Channel"
        message="This will permanently delete the channel and all its messages for all members. This action cannot be undone."
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setShowDeleteDialog(false)}
      />

      {/* Add Member sheet */}
      <BottomSheet
        isOpen={showAddMemberSheet}
        onClose={closeAddMemberSheet}
        title="Add Member"
        size="tall"
        bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden px-5 pb-4"
      >
        {/* Search input */}
        <div className="flex-shrink-0 pb-3">
          <input
            type="text"
            value={addMemberSearch}
            onChange={(e) => setAddMemberSearch(e.target.value)}
            placeholder="Search by name or email..."
            className="w-full rounded-xl border border-line bg-surface-2 px-4 py-2.5 text-body text-ink-1 placeholder-ink-3 focus:outline-none focus:ring-2 focus:ring-acc focus:border-acc"
          />
        </div>

        {/* User list */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {availableUsers.length === 0 ? (
            <p className="text-center text-body text-ink-3 py-6">
              {addMemberSearch ? 'No users match your search' : 'All users are already members'}
            </p>
          ) : (
            <div className="space-y-1">
              {availableUsers.map((u) => (
                <button
                  key={u.id}
                  onClick={() => {
                    void handleAddMember(u.id);
                  }}
                  disabled={actionLoading}
                  className="w-full flex items-center gap-3 px-3 py-2.5 min-h-touch rounded-xl hover:bg-surface-2 touch-feedback transition-colors"
                >
                  <div className="w-10 h-10 rounded-full bg-acc-dim flex items-center justify-center flex-shrink-0">
                    <span className="text-body font-bold text-acc">
                      {u.name.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div className="flex-1 text-left min-w-0">
                    <p className="text-body font-medium text-ink-1 truncate">{u.name}</p>
                    <p className="text-meta text-ink-3 truncate">{u.email}</p>
                  </div>
                  {u.isOnline && <div className="w-2.5 h-2.5 rounded-full bg-ok flex-shrink-0" />}
                </button>
              ))}
            </div>
          )}
        </div>
      </BottomSheet>
    </div>
  );
}
