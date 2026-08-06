/**
 * NewChatPage -- User picker for starting new DM or group conversations.
 * Includes AI Assistants persona picker section (Phase 4).
 *
 * WHY this design: Starting a conversation needs to be fast for field workers.
 * The page shows AI assistant personas at the top, followed by a searchable
 * list of tenant users with online indicators. Tapping an AI persona creates
 * an AI channel with that persona and navigates to AiChatPage. Tapping a user
 * creates a DM channel. The "New Group" flow allows multi-select.
 *
 * @see ADR-012 Phase 4 (AI Persona-Based Messaging Channels)
 */

import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  Search,
  Users,
  Check,
  Plus,
  X,
  UserPlus,
  AlertCircle,
  Bot,
  Droplets,
  Fish,
  BarChart,
  Cpu,
  Sparkles,
} from 'lucide-react';
import { useState, useCallback, useMemo, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';

import { AppHeader } from '@/components/AppHeader';
import { Button, Card, Chip, EmptyState, IconButton, Skeleton } from '@/components/ui';
import { AVAILABLE_AI_PERSONAS } from '@/graphql/messaging-operations';
import { useAuth } from '@/hooks/useAuth';
import { useCreateChannel } from '@/hooks/useCreateChannel';
import type { TenantUserItem } from '@/hooks/useTenantUsers';
import { useTenantUsers } from '@/hooks/useTenantUsers';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type { AiPersona } from '@/types/messaging';
import { getInitials } from '@/utils/messaging-helpers';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

// ---------------------------------------------------------------------------
// AI Persona Helpers
// ---------------------------------------------------------------------------

/** Map persona icon name to Lucide component. */
const PERSONA_ICONS: Record<string, typeof Bot> = {
  bot: Bot,
  droplets: Droplets,
  fish: Fish,
  'bar-chart': BarChart,
  cpu: Cpu,
};

/**
 * Map the persona's server-side colour name onto the v4 decorative hues.
 *
 * WHY these five and not the Tailwind ramps they replace: the token layer
 * offers exactly five hues that are NOT already spoken for by an alarm meaning
 * (coral is excluded on purpose — it means "something is wrong" everywhere else
 * in the app), and each resolves per theme, which the fixed light/dark Tailwind
 * ramp pairs they replace could not. The colour NAMES stay the server's
 * vocabulary because they are part of the persona contract; only what they
 * resolve to changes. The same five back ChannelAvatar and MessageBubble, so a
 * persona keeps its hue wherever it appears.
 */
const PERSONA_COLORS: Record<string, { border: string; bg: string; text: string }> = {
  purple: {
    border: 'border-type-transfer',
    bg: 'bg-type-transfer-dim',
    text: 'text-type-transfer',
  },
  cyan: { border: 'border-acc', bg: 'bg-acc-dim', text: 'text-acc' },
  blue: { border: 'border-type-water', bg: 'bg-type-water-dim', text: 'text-type-water' },
  green: { border: 'border-type-harvest', bg: 'bg-type-harvest-dim', text: 'text-type-harvest' },
  orange: { border: 'border-type-cull', bg: 'bg-type-cull-dim', text: 'text-type-cull' },
};

/** A single AI persona card for the persona picker grid. */
function AiPersonaCard({
  persona,
  onPress,
  disabled,
}: {
  persona: AiPersona;
  onPress: () => void;
  disabled: boolean;
}): JSX.Element {
  const IconComponent = PERSONA_ICONS[persona.icon] ?? Bot;
  const colors = PERSONA_COLORS[persona.color] ?? PERSONA_COLORS['purple'];

  return (
    <button
      onClick={onPress}
      disabled={disabled}
      className={clsx(
        'flex flex-col items-start gap-2 p-3 min-h-touch rounded-2xl border-2 bg-surface-1 shadow-token transition-all touch-feedback',
        'active:scale-[0.97] disabled:opacity-50',
        colors.border,
      )}
    >
      <div className={clsx('w-9 h-9 rounded-lg flex items-center justify-center', colors.bg)}>
        <IconComponent size={18} className={colors.text} />
      </div>
      <div className="text-left">
        <h4 className="text-body font-bold text-ink-1 leading-tight">{persona.name}</h4>
        {/* text-meta is 12px, the sunlight floor — it replaces a 10px arbitrary
            size, so it LOWERS the tiny-text ratchet. */}
        <p className="text-meta text-ink-3 leading-tight mt-0.5 line-clamp-2">
          {persona.description}
        </p>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** A single user row for the contact list. */
function UserRow({
  user,
  isSelected,
  showCheckbox,
  onPress,
}: {
  user: TenantUserItem;
  isSelected: boolean;
  showCheckbox: boolean;
  onPress: () => void;
}): JSX.Element {
  return (
    <button
      onClick={onPress}
      className="w-full flex items-center gap-3 px-4 py-3 min-h-touch touch-feedback transition-all active:bg-surface-2"
    >
      {/* Avatar. The brand gradient becomes a flat accent: the token layer has
          one accent value per theme and no gradient pair, so a two-stop gradient
          built from the same variable would just BE the flat colour. */}
      <div className="relative flex-shrink-0">
        {user.avatarUrl ? (
          <img
            src={user.avatarUrl}
            alt={user.name}
            className="w-11 h-11 rounded-full object-cover"
          />
        ) : (
          <div className="w-11 h-11 rounded-full bg-acc flex items-center justify-center text-body font-bold text-acc-on">
            {getInitials(user.name)}
          </div>
        )}
        {/* `ok` is the confirm token; the ring takes the surface the avatar sits
            on rather than a fixed white — same treatment as ChannelAvatar. */}
        {user.isOnline && (
          <div className="absolute bottom-0 right-0 w-3 h-3 bg-ok border-2 border-surface-1 rounded-full" />
        )}
      </div>

      {/* User info */}
      <div className="flex-1 min-w-0 text-left">
        <h3 className="text-body font-semibold text-ink-1 truncate">{user.name}</h3>
        <p className="text-meta text-ink-3 truncate">{user.email}</p>
      </div>

      {/* Selection indicator — the accent is how v4 says "selected". */}
      {showCheckbox && (
        <div
          className={clsx(
            'w-6 h-6 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-all',
            isSelected ? 'bg-acc border-acc' : 'border-line-strong',
          )}
        >
          {isSelected && <Check size={14} className="text-acc-on" />}
        </div>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

/**
 * NewChatPage provides a user picker for creating new DM or group channels.
 * Supports search-as-you-type, multi-select for groups, and immediate
 * navigation to the new chat room upon channel creation.
 */
export function NewChatPage(): JSX.Element {
  const navigate = useNavigate();
  const { user: currentUser, tenantId, hasPermission } = useAuth();
  // Tenant-RBAC: only members granted `channels:create_group` see the group
  // entry point (admins bypass). DM + AI stay available to everyone. The
  // backend re-checks the capability on create — this is UI visibility only.
  const canCreateGroup = hasPermission('channels:create_group');
  // Tenant-RBAC (Faz 7c): the AI assistant needs `ai_assistant:use`, and each
  // persona is shown only if the user may drive its tier (`ai_personas:<tier>`).
  // Mirrors the ai-service backend gates (ai_assistant:use + ai_personas:<tier>);
  // this is UI visibility only — the backend re-checks on chat.
  const canUseAi = hasPermission('ai_assistant:use');
  const { users, isLoading: usersLoading, error: usersError } = useTenantUsers();
  const { createDM, createGroup, createAiChannel, isCreating } = useCreateChannel();

  // Fetch available AI personas for the current tenant
  const { data: aiPersonas = [] } = useQuery({
    queryKey: createTenantQueryKey(tenantId, 'messaging', 'aiPersonas'),
    queryFn: async () => {
      const result = await graphqlRequest<{ availableAiPersonas: AiPersona[] }>(
        AVAILABLE_AI_PERSONAS,
      );
      return result.availableAiPersonas ?? [];
    },
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
    enabled: !!tenantId,
  });

  // Tenant-RBAC (Faz 7c): show only personas whose tier the user may drive.
  // Tier is the persona id prefix ('expert-v1' → 'expert'); an id-less/unknown
  // persona defaults to the operator tier (the base every granted role has).
  // Empty when the user lacks ai_assistant:use, so the whole section hides.
  const visibleAiPersonas = useMemo(() => {
    if (!canUseAi) return [];
    const tierOf = (id: string | null | undefined): string => {
      const prefix = (id ?? '').split('-')[0];
      return ['operator', 'manager', 'expert', 'supervisor'].includes(prefix)
        ? prefix
        : 'operator';
    };
    return aiPersonas.filter((p) => hasPermission(`ai_personas:${tierOf(p.id)}`));
  }, [aiPersonas, canUseAi, hasPermission]);

  const [searchQuery, setSearchQuery] = useState('');
  const [isGroupMode, setIsGroupMode] = useState(false);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [groupName, setGroupName] = useState('');
  const [showGroupNameInput, setShowGroupNameInput] = useState(false);

  // Filter users by search and exclude current user
  const filteredUsers = useMemo(() => {
    const available = users.filter((u) => u.id !== currentUser?.id);

    if (!searchQuery.trim()) return available;

    const query = searchQuery.toLowerCase();
    return available.filter(
      (u) =>
        u.name.toLowerCase().includes(query) ||
        u.email.toLowerCase().includes(query),
    );
  }, [users, searchQuery, currentUser?.id]);

  // Handle tapping a user
  const handleUserPress = useCallback(
    async (userId: string) => {
      if (isGroupMode) {
        setSelectedUserIds((prev) => {
          const next = new Set(prev);
          if (next.has(userId)) {
            next.delete(userId);
          } else {
            next.add(userId);
          }
          return next;
        });
        return;
      }

      // DM mode: create channel and navigate
      try {
        const channelId = await createDM(userId);
        if (channelId) {
          navigate(`/messages/${channelId}`, { replace: true });
        }
      } catch {
        // Error is handled by the hook
      }
    },
    [isGroupMode, createDM, navigate],
  );

  const handleToggleGroupMode = useCallback(() => {
    if (isGroupMode) {
      setIsGroupMode(false);
      setSelectedUserIds(new Set());
      setGroupName('');
      setShowGroupNameInput(false);
    } else {
      setIsGroupMode(true);
    }
  }, [isGroupMode]);

  const handleProceedToGroupName = useCallback(() => {
    if (selectedUserIds.size < 2) return;
    setShowGroupNameInput(true);
  }, [selectedUserIds.size]);

  const handleCreateGroup = useCallback(async () => {
    const name = groupName.trim();
    if (!name || selectedUserIds.size < 2) return;

    try {
      const channelId = await createGroup(name, Array.from(selectedUserIds));
      if (channelId) {
        navigate(`/messages/${channelId}`, { replace: true });
      }
    } catch {
      // Error is handled by the hook
    }
  }, [groupName, selectedUserIds, createGroup, navigate]);

  // Handle tapping an AI persona card
  const handleAiPersonaPress = useCallback(
    async (persona: AiPersona) => {
      try {
        const channelId = await createAiChannel(
          persona.id ?? undefined,
          persona.name,
        );
        if (channelId) {
          navigate(`/messages/ai/${channelId}`, { replace: true });
        }
      } catch {
        // Error is handled by the hook
      }
    },
    [createAiChannel, navigate],
  );

  const selectedUserNames = useMemo(() => {
    return users
      .filter((u) => selectedUserIds.has(u.id))
      .map((u) => u.name);
  }, [users, selectedUserIds]);

  const loading = usersLoading;
  const errorMsg = usersError
    ? (usersError instanceof Error ? usersError.message : 'Failed to load users')
    : null;

  return (
    // The page ground comes from <body>, so no background is set here.
    <div className="min-h-screen">
      {/* The shared header replaces this screen's own ocean-gradient banner.
          showAvatar={false}: this is a sub-screen reached from the dock, and the
          account route already hangs off the destination it came from. */}
      <AppHeader
        title={showGroupNameInput ? 'Name Your Group' : 'New Message'}
        onBack={() => navigate('/messages')}
        showAvatar={false}
        actions={
          isGroupMode && !showGroupNameInput ? (
            <Button variant="secondary" onClick={handleToggleGroupMode} className="text-body px-3">
              Cancel
            </Button>
          ) : undefined
        }
      />

      {/* Group name input panel */}
      {showGroupNameInput ? (
        <div className="px-4 pt-1 space-y-4">
          <Card className="p-4">
            <label
              htmlFor="new-group-name"
              className="text-meta font-semibold text-ink-3 uppercase tracking-wider mb-2 block"
            >
              Group Name
            </label>
            <input
              id="new-group-name"
              type="text"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="Enter group name..."
              maxLength={100}
              // The field is a recessed well inside the card, matching the
              // composer's textarea rather than drawing its own outline.
              className="w-full border border-line rounded-xl px-4 py-3 text-body bg-surface-2 text-ink-1 placeholder-ink-3 outline-none focus:border-acc focus:ring-2 focus:ring-acc transition-all"
            />

            <div className="mt-3">
              <p className="text-meta text-ink-3 mb-2">
                {selectedUserNames.length} members selected
              </p>
              <div className="flex flex-wrap gap-1.5">
                {selectedUserNames.map((name) => (
                  <Chip key={name} tone="accent">
                    {name}
                  </Chip>
                ))}
              </div>
            </div>
          </Card>

          <div className="flex gap-3">
            <Button variant="secondary" size="save" block onClick={() => setShowGroupNameInput(false)}>
              Back
            </Button>
            <Button
              variant="primary"
              size="save"
              block
              onClick={() => { void handleCreateGroup(); }}
              disabled={!groupName.trim() || isCreating}
            >
              {isCreating ? (
                <span className="animate-spin rounded-full h-5 w-5 border-2 border-acc-on border-t-transparent" />
              ) : (
                <>
                  <UserPlus size={18} />
                  Create Group
                </>
              )}
            </Button>
          </div>
        </div>
      ) : (
        <>
          {/* Search bar */}
          <div className="px-4 pt-1">
            <div className="relative">
              <Search
                size={18}
                className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3"
                aria-hidden
              />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by name or email..."
                aria-label="Search by name or email"
                className="w-full bg-surface-1 border border-line rounded-2xl pl-10 pr-14 py-3 text-body text-ink-1 placeholder-ink-3 outline-none focus:border-acc focus:ring-2 focus:ring-acc transition-all"
              />
              {searchQuery && (
                // IconButton bakes in the 44px floor the hand-rolled `p-1`
                // clear button never reached, plus the missing accessible name.
                <IconButton
                  onClick={() => setSearchQuery('')}
                  className="absolute right-1 top-1/2 -translate-y-1/2"
                  aria-label="Clear search"
                >
                  <X size={16} className="text-ink-3" />
                </IconButton>
              )}
            </div>
          </div>

          {/* AI Assistants section — gated on ai_assistant:use + per-persona ai_personas:<tier> */}
          {!isGroupMode && visibleAiPersonas.length > 0 && (
            <div className="px-4 pt-3">
              <h2 className="text-meta font-semibold text-ink-3 uppercase tracking-wider px-1 mb-2 flex items-center gap-1.5">
                <Sparkles size={12} />
                AI Assistants
              </h2>
              <div className="grid grid-cols-2 gap-2">
                {visibleAiPersonas.map((persona) => (
                  <AiPersonaCard
                    key={persona.id ?? 'general'}
                    persona={persona}
                    onPress={() => { void handleAiPersonaPress(persona); }}
                    disabled={isCreating}
                  />
                ))}
              </div>
            </div>
          )}

          {/* New Group button — gated on the channels:create_group capability */}
          {!isGroupMode && canCreateGroup && (
            <div className="px-4 pt-3">
              <button
                onClick={handleToggleGroupMode}
                className="w-full flex items-center gap-3 bg-surface-1 rounded-2xl border border-line shadow-token p-4 min-h-touch touch-feedback transition-all"
              >
                {/* Teal, not the old violet: v4 gives the accent EVERY action,
                    and starting a group is an action rather than an identity. */}
                <div className="w-11 h-11 rounded-full bg-acc flex items-center justify-center">
                  <Users size={20} className="text-acc-on" />
                </div>
                <div className="text-left">
                  <h3 className="text-body font-semibold text-ink-1">New Group</h3>
                  <p className="text-meta text-ink-3">Create a group conversation</p>
                </div>
              </button>
            </div>
          )}

          {/* Group mode: selected count + next button */}
          {isGroupMode && selectedUserIds.size > 0 && (
            <div className="px-4 pt-3">
              {/* The accent's own dim wash is how v4 marks an active selection. */}
              <div className="bg-acc-dim rounded-2xl p-3 flex items-center justify-between border border-acc">
                <div className="flex items-center gap-2">
                  <Users size={16} className="text-acc" />
                  <span className="text-body font-medium text-acc">
                    {selectedUserIds.size} selected
                  </span>
                </div>
                <Button
                  variant="primary"
                  onClick={handleProceedToGroupName}
                  disabled={selectedUserIds.size < 2}
                  className="text-body px-3"
                >
                  Next
                  <Plus size={14} />
                </Button>
              </div>
            </div>
          )}

          {/* User list */}
          <div className="pt-3">
            <h2 className="text-meta font-semibold text-ink-3 uppercase tracking-wider px-5 mb-2">
              {isGroupMode ? 'Select Members' : 'Contacts'}
            </h2>

            {loading ? (
              <div className="px-4">
                <Skeleton variant="row" count={4} />
              </div>
            ) : errorMsg ? (
              // tone="error" keeps "we could not fetch the directory" visually
              // distinct from "this tenant has no other members".
              <EmptyState
                tone="error"
                icon={<AlertCircle size={22} />}
                title="Could not load contacts"
                description={errorMsg}
              />
            ) : filteredUsers.length === 0 ? (
              <EmptyState
                icon={<Search size={22} />}
                title={searchQuery ? 'No users found' : 'No contacts available'}
                description={searchQuery ? 'Try a different search term' : undefined}
              />
            ) : (
              <div className="divide-y divide-line">
                {filteredUsers.map((u) => (
                  <UserRow
                    key={u.id}
                    user={u}
                    isSelected={selectedUserIds.has(u.id)}
                    showCheckbox={isGroupMode}
                    onPress={() => { void handleUserPress(u.id); }}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* Loading overlay for channel creation */}
      {isCreating && !showGroupNameInput && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <Card className="p-6 flex flex-col items-center gap-3">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-acc" />
            <p className="text-body font-medium text-ink-2">Creating conversation...</p>
          </Card>
        </div>
      )}

      {/* Bottom spacer for tab bar */}
      <div className="h-24" />
    </div>
  );
}
