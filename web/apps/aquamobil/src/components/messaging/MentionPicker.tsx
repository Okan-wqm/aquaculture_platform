/**
 * @module MentionPicker
 * @description Dropdown picker for @mentions in the message input.
 * Triggered when user types '@' character, displays filtered channel
 * members, and inserts the selected mention into the input text.
 *
 * WHY dropdown above input: On mobile, the keyboard occupies the bottom
 * half of the screen. Placing the picker above the input keeps it visible
 * without scrolling or keyboard dismissal.
 *
 * WHY keyboard navigation: Desktop users expect up/down/enter for picker
 * interaction. Mobile users use touch.
 *
 * @see ADR-012 section 5.4 (Mentions)
 */

import { clsx } from 'clsx';
import { useState, useEffect, useCallback, useRef, useMemo, type ReactElement } from 'react';

import type { ChannelMember } from '@/types/messaging';
import { getInitials, getUserDisplayName } from '@/utils/messaging-helpers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MentionPickerProps {
  /** Active channel members to choose from. */
  members: ChannelMember[];
  /** The text typed after '@' for filtering. */
  filterText: string;
  /** Callback when a member is selected for mention. */
  onSelect: (member: ChannelMember) => void;
  /** Callback when the picker should be dismissed (Escape or no match). */
  onDismiss: () => void;
  /** Whether the picker is visible. */
  visible: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum members to display in the picker dropdown. */
const MAX_VISIBLE = 6;

/**
 * Avatar color palette for members without profile images.
 *
 * The same five hues MessageBubble and ChannelAvatar use, in their dim/solid
 * pairing — so a person keeps one hue whether they appear as a sender name, an
 * avatar disc or a mention suggestion. None of them is an alarm colour.
 */
const AVATAR_COLORS = [
  'bg-acc-dim text-acc',
  'bg-type-water-dim text-type-water',
  'bg-type-transfer-dim text-type-transfer',
  'bg-type-cull-dim text-type-cull',
  'bg-type-harvest-dim text-type-harvest',
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getMemberDisplayName(member: ChannelMember): string {
  if (member.user) {
    return getUserDisplayName(member.user);
  }
  return member.userId;
}

function getMemberRole(member: ChannelMember): string {
  // S1-CODEGEN: ChannelMemberRole wire form is the UPPERCASE GraphQL enum NAME.
  switch (member.role) {
    case 'OWNER':
      return 'Owner';
    case 'ADMIN':
      return 'Admin';
    default:
      return 'Member';
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * MentionPicker -- floating dropdown for selecting @mention targets.
 */
export function MentionPicker({
  members,
  filterText,
  onSelect,
  onDismiss,
  visible,
}: MentionPickerProps): ReactElement | null {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Filter members by typed text (case-insensitive)
  const filteredMembers = useMemo(() => {
    const lowerFilter = filterText.toLowerCase();
    const filtered = members.filter((m) => {
      if (!lowerFilter) return true;
      const name = getMemberDisplayName(m).toLowerCase();
      return name.includes(lowerFilter);
    });
    return filtered.slice(0, MAX_VISIBLE);
  }, [members, filterText]);

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [filterText]);

  // Auto-dismiss if no matches
  useEffect(() => {
    if (visible && filteredMembers.length === 0 && filterText.length > 2) {
      onDismiss();
    }
  }, [visible, filteredMembers.length, filterText, onDismiss]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!visible || filteredMembers.length === 0) return;

      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((prev) => (prev <= 0 ? filteredMembers.length - 1 : prev - 1));
          break;
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) => (prev >= filteredMembers.length - 1 ? 0 : prev + 1));
          break;
        case 'Enter':
        case 'Tab':
          e.preventDefault();
          if (filteredMembers[selectedIndex]) {
            onSelect(filteredMembers[selectedIndex]);
          }
          break;
        case 'Escape':
          e.preventDefault();
          onDismiss();
          break;
      }
    },
    [visible, filteredMembers, selectedIndex, onSelect, onDismiss],
  );

  useEffect(() => {
    if (visible) {
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [visible, handleKeyDown]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selected = list.children[selectedIndex] as HTMLElement | undefined;
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  if (!visible || filteredMembers.length === 0) {
    return null;
  }

  return (
    <div
      ref={listRef}
      className={clsx(
        'absolute bottom-full left-0 right-0 mb-1 z-50',
        'bg-surface-1 rounded-xl shadow-token',
        'border border-line',
        'max-h-[280px] overflow-y-auto',
      )}
      role="listbox"
      aria-label="Mention suggestions"
    >
      {filteredMembers.map((member, index) => {
        const name = getMemberDisplayName(member);
        const initials = getInitials(name);
        const avatarUrl = member.user?.avatarUrl ?? member.user?.profileImageUrl;
        const colorClass = AVATAR_COLORS[index % AVATAR_COLORS.length];
        const isSelected = index === selectedIndex;

        return (
          <button
            key={member.id}
            role="option"
            aria-selected={isSelected}
            onClick={() => onSelect(member)}
            className={clsx(
              'flex items-center gap-3 w-full px-4 py-2.5 min-h-[48px] text-left touch-feedback transition-colors',
              isSelected ? 'bg-acc-dim' : 'hover:bg-surface-2',
            )}
          >
            {/* Avatar */}
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={name}
                className="w-8 h-8 rounded-full object-cover shrink-0"
              />
            ) : (
              <div
                className={clsx(
                  'w-8 h-8 rounded-full flex items-center justify-center text-meta font-bold shrink-0',
                  colorClass,
                )}
              >
                {initials}
              </div>
            )}

            {/* Name + role */}
            <div className="flex-1 min-w-0">
              <p className="text-body font-medium text-ink-1 truncate">{name}</p>
              <p className="text-meta text-ink-3">{getMemberRole(member)}</p>
            </div>
          </button>
        );
      })}
    </div>
  );
}
