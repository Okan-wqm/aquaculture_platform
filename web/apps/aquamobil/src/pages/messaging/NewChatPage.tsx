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
  ArrowLeft,
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

/** Map persona color name to Tailwind gradient classes. */
const PERSONA_COLORS: Record<string, { border: string; bg: string; text: string }> = {
  purple: { border: 'border-purple-400', bg: 'bg-purple-50 dark:bg-purple-900/30', text: 'text-purple-600 dark:text-purple-400' },
  cyan: { border: 'border-cyan-400', bg: 'bg-cyan-50 dark:bg-cyan-900/30', text: 'text-cyan-600 dark:text-cyan-400' },
  blue: { border: 'border-blue-400', bg: 'bg-blue-50 dark:bg-blue-900/30', text: 'text-blue-600 dark:text-blue-400' },
  green: { border: 'border-green-400', bg: 'bg-green-50 dark:bg-green-900/30', text: 'text-green-600 dark:text-green-400' },
  orange: { border: 'border-orange-400', bg: 'bg-orange-50 dark:bg-orange-900/30', text: 'text-orange-600 dark:text-orange-400' },
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
        'flex flex-col items-start gap-2 p-3 rounded-xl border-2 bg-white dark:bg-gray-900 transition-all touch-feedback',
        'active:scale-[0.97] disabled:opacity-50',
        colors.border,
      )}
    >
      <div className={clsx('w-9 h-9 rounded-lg flex items-center justify-center', colors.bg)}>
        <IconComponent size={18} className={colors.text} />
      </div>
      <div className="text-left">
        <h4 className="text-xs font-bold text-gray-900 dark:text-white leading-tight">
          {persona.name}
        </h4>
        <p className="text-[10px] text-gray-400 dark:text-gray-500 leading-tight mt-0.5 line-clamp-2">
          {persona.description}
        </p>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Skeleton loader for user list items. */
function UserSkeleton(): JSX.Element {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="w-11 h-11 rounded-full skeleton flex-shrink-0" />
      <div className="flex-1 space-y-2">
        <div className="h-4 w-32 rounded skeleton" />
        <div className="h-3 w-44 rounded skeleton" />
      </div>
    </div>
  );
}

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
      className="w-full flex items-center gap-3 px-4 py-3 touch-feedback transition-all active:bg-gray-50 dark:active:bg-gray-800/50"
    >
      {/* Avatar */}
      <div className="relative flex-shrink-0">
        {user.avatarUrl ? (
          <img
            src={user.avatarUrl}
            alt={user.name}
            className="w-11 h-11 rounded-full object-cover"
          />
        ) : (
          <div className="w-11 h-11 rounded-full bg-gradient-to-br from-ocean-400 to-ocean-600 flex items-center justify-center text-sm font-bold text-white">
            {getInitials(user.name)}
          </div>
        )}
        {user.isOnline && (
          <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 border-2 border-white dark:border-gray-900 rounded-full" />
        )}
      </div>

      {/* User info */}
      <div className="flex-1 min-w-0 text-left">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white truncate">
          {user.name}
        </h3>
        <p className="text-xs text-gray-400 dark:text-gray-500 truncate">
          {user.email}
        </p>
      </div>

      {/* Selection indicator */}
      {showCheckbox && (
        <div
          className={clsx(
            'w-6 h-6 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-all',
            isSelected
              ? 'bg-ocean-500 border-ocean-500'
              : 'border-gray-300 dark:border-gray-600',
          )}
        >
          {isSelected && <Check size={14} className="text-white" />}
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
      const result = await graphqlRequest(
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
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Header */}
      <div className="bg-gradient-to-r from-ocean-600 to-ocean-500 text-white">
        <div className="flex items-center gap-3 px-4 py-4 pt-safe-top">
          <button
            onClick={() => navigate('/messages')}
            className="p-2 -ml-2 rounded-xl hover:bg-white/10 touch-feedback"
          >
            <ArrowLeft size={22} />
          </button>
          <h1 className="text-lg font-bold flex-1">
            {showGroupNameInput ? 'Name Your Group' : 'New Message'}
          </h1>
          {isGroupMode && !showGroupNameInput && (
            <button
              onClick={handleToggleGroupMode}
              className="text-sm font-medium bg-white/20 px-3 py-1.5 rounded-lg touch-feedback"
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* Group name input panel */}
      {showGroupNameInput ? (
        <div className="px-4 pt-4 space-y-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card border border-gray-100 dark:border-gray-800 p-4">
            <label
              htmlFor="new-group-name"
              className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 block"
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
              className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 text-sm bg-transparent text-gray-900 dark:text-white placeholder-gray-400 outline-none focus:border-ocean-500 focus:ring-2 focus:ring-ocean-500/20 transition-all"
            />

            <div className="mt-3">
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                {selectedUserNames.length} members selected
              </p>
              <div className="flex flex-wrap gap-1.5">
                {selectedUserNames.map((name) => (
                  <span
                    key={name}
                    className="text-xs bg-ocean-50 dark:bg-ocean-900/30 text-ocean-700 dark:text-ocean-300 px-2.5 py-1 rounded-full font-medium"
                  >
                    {name}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => setShowGroupNameInput(false)}
              className="flex-1 py-3.5 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 font-semibold rounded-2xl touch-feedback transition-all text-sm"
            >
              Back
            </button>
            <button
              onClick={() => { void handleCreateGroup(); }}
              disabled={!groupName.trim() || isCreating}
              className="flex-1 py-3.5 bg-gradient-to-r from-ocean-600 to-ocean-500 text-white font-semibold rounded-2xl shadow-lg shadow-ocean-500/25 disabled:opacity-50 touch-feedback transition-all text-sm flex items-center justify-center gap-2"
            >
              {isCreating ? (
                <span className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
              ) : (
                <>
                  <UserPlus size={18} />
                  Create Group
                </>
              )}
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Search bar */}
          <div className="px-4 pt-4">
            <div className="relative">
              <Search
                size={18}
                className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400"
              />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by name or email..."
                className="w-full bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl pl-10 pr-4 py-3 text-sm text-gray-900 dark:text-white placeholder-gray-400 outline-none focus:border-ocean-500 focus:ring-2 focus:ring-ocean-500/20 transition-all"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-1"
                >
                  <X size={16} className="text-gray-400" />
                </button>
              )}
            </div>
          </div>

          {/* AI Assistants section — gated on ai_assistant:use + per-persona ai_personas:<tier> */}
          {!isGroupMode && visibleAiPersonas.length > 0 && (
            <div className="px-4 pt-3">
              <h2 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider px-1 mb-2 flex items-center gap-1.5">
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
                className="w-full flex items-center gap-3 bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 touch-feedback transition-all"
              >
                <div className="w-11 h-11 rounded-full bg-gradient-to-br from-purple-400 to-purple-600 flex items-center justify-center">
                  <Users size={20} className="text-white" />
                </div>
                <div className="text-left">
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
                    New Group
                  </h3>
                  <p className="text-xs text-gray-400 dark:text-gray-500">
                    Create a group conversation
                  </p>
                </div>
              </button>
            </div>
          )}

          {/* Group mode: selected count + next button */}
          {isGroupMode && selectedUserIds.size > 0 && (
            <div className="px-4 pt-3">
              <div className="bg-ocean-50 dark:bg-ocean-900/20 rounded-xl p-3 flex items-center justify-between border border-ocean-200 dark:border-ocean-800">
                <div className="flex items-center gap-2">
                  <Users size={16} className="text-ocean-600" />
                  <span className="text-sm font-medium text-ocean-700 dark:text-ocean-300">
                    {selectedUserIds.size} selected
                  </span>
                </div>
                <button
                  onClick={handleProceedToGroupName}
                  disabled={selectedUserIds.size < 2}
                  className="flex items-center gap-1 px-3 py-1.5 bg-ocean-500 text-white rounded-lg text-sm font-semibold touch-feedback disabled:opacity-50"
                >
                  Next
                  <Plus size={14} />
                </button>
              </div>
            </div>
          )}

          {/* User list */}
          <div className="pt-3">
            <h2 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider px-5 mb-2">
              {isGroupMode ? 'Select Members' : 'Contacts'}
            </h2>

            {loading ? (
              <div className="space-y-1">
                {[1, 2, 3, 4].map((i) => (
                  <UserSkeleton key={i} />
                ))}
              </div>
            ) : errorMsg ? (
              <div className="text-center py-12 px-4">
                <AlertCircle
                  size={40}
                  className="mx-auto mb-3 text-gray-300 opacity-60"
                />
                <p className="text-sm text-gray-500">{errorMsg}</p>
              </div>
            ) : filteredUsers.length === 0 ? (
              <div className="text-center py-12 px-4">
                <Search
                  size={40}
                  className="mx-auto mb-3 text-gray-300 dark:text-gray-600 opacity-30"
                />
                <p className="font-medium text-gray-500 dark:text-gray-400">
                  {searchQuery ? 'No users found' : 'No contacts available'}
                </p>
                {searchQuery && (
                  <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">
                    Try a different search term
                  </p>
                )}
              </div>
            ) : (
              <div className="divide-y divide-gray-100 dark:divide-gray-800/50">
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
          <div className="bg-white dark:bg-gray-900 rounded-2xl p-6 flex flex-col items-center gap-3 shadow-xl">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ocean-500" />
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Creating conversation...
            </p>
          </div>
        </div>
      )}

      {/* Bottom spacer for tab bar */}
      <div className="h-24" />
    </div>
  );
}
