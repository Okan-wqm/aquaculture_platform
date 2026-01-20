/**
 * useReportDraft Hook
 * Manages draft saving/loading for regulatory reports using localStorage
 *
 * Provides:
 * - Auto-save draft on form changes
 * - Load existing draft on form open
 * - Clear draft on successful submission
 * - Draft expiry (7 days default)
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { ReportType } from '../types/reports.types';

// ============================================================================
// Types
// ============================================================================

interface DraftData<T> {
  data: T;
  savedAt: string;
  version: number;
}

interface UseReportDraftOptions {
  /** Auto-save interval in milliseconds (default: 5000) */
  autoSaveInterval?: number;
  /** Draft expiry in days (default: 7) */
  expiryDays?: number;
  /** Enable auto-save (default: true) */
  enableAutoSave?: boolean;
}

interface UseReportDraftReturn<T> {
  /** Save draft manually */
  saveDraft: (data: T) => void;
  /** Load existing draft (returns null if none or expired) */
  loadDraft: () => DraftData<T> | null;
  /** Check if draft exists */
  hasDraft: () => boolean;
  /** Clear draft */
  clearDraft: () => void;
  /** Whether auto-save is pending */
  isPending: boolean;
  /** Last saved timestamp */
  lastSaved: Date | null;
  /** Draft age in human-readable format */
  draftAge: string | null;
}

// ============================================================================
// Constants
// ============================================================================

const DRAFT_KEY_PREFIX = 'regulatory_report_draft_';
const DRAFT_VERSION = 1;
const DEFAULT_EXPIRY_DAYS = 7;
const DEFAULT_AUTO_SAVE_INTERVAL = 5000;

// ============================================================================
// Hook Implementation
// ============================================================================

export function useReportDraft<T>(
  reportType: ReportType,
  reportId?: string,
  options: UseReportDraftOptions = {}
): UseReportDraftReturn<T> {
  const {
    autoSaveInterval = DEFAULT_AUTO_SAVE_INTERVAL,
    expiryDays = DEFAULT_EXPIRY_DAYS,
    enableAutoSave = true,
  } = options;

  // Generate storage key
  const storageKey = `${DRAFT_KEY_PREFIX}${reportType}_${reportId || 'new'}`;

  // State
  const [isPending, setIsPending] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const pendingDataRef = useRef<T | null>(null);
  const autoSaveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /**
   * Check if draft is expired
   */
  const isDraftExpired = useCallback(
    (savedAt: string): boolean => {
      const savedDate = new Date(savedAt);
      const now = new Date();
      const diffMs = now.getTime() - savedDate.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      return diffDays > expiryDays;
    },
    [expiryDays]
  );

  /**
   * Save draft to localStorage
   */
  const saveDraft = useCallback(
    (data: T) => {
      try {
        const draftData: DraftData<T> = {
          data,
          savedAt: new Date().toISOString(),
          version: DRAFT_VERSION,
        };
        localStorage.setItem(storageKey, JSON.stringify(draftData));
        setLastSaved(new Date());
        setIsPending(false);
      } catch (error) {
        console.error('Failed to save draft:', error);
      }
    },
    [storageKey]
  );

  /**
   * Load draft from localStorage
   */
  const loadDraft = useCallback((): DraftData<T> | null => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (!stored) return null;

      const parsed: DraftData<T> = JSON.parse(stored);

      // Check version compatibility
      if (parsed.version !== DRAFT_VERSION) {
        console.warn('Draft version mismatch, discarding');
        localStorage.removeItem(storageKey);
        return null;
      }

      // Check expiry
      if (isDraftExpired(parsed.savedAt)) {
        console.warn('Draft expired, discarding');
        localStorage.removeItem(storageKey);
        return null;
      }

      setLastSaved(new Date(parsed.savedAt));
      return parsed;
    } catch (error) {
      console.error('Failed to load draft:', error);
      return null;
    }
  }, [storageKey, isDraftExpired]);

  /**
   * Check if draft exists
   */
  const hasDraft = useCallback((): boolean => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (!stored) return false;

      const parsed: DraftData<T> = JSON.parse(stored);
      return !isDraftExpired(parsed.savedAt);
    } catch {
      return false;
    }
  }, [storageKey, isDraftExpired]);

  /**
   * Clear draft from localStorage
   */
  const clearDraft = useCallback(() => {
    try {
      localStorage.removeItem(storageKey);
      setLastSaved(null);
      setIsPending(false);
      pendingDataRef.current = null;
    } catch (error) {
      console.error('Failed to clear draft:', error);
    }
  }, [storageKey]);

  /**
   * Calculate draft age
   */
  const draftAge = lastSaved
    ? formatDraftAge(lastSaved)
    : null;

  /**
   * Auto-save effect
   */
  useEffect(() => {
    if (!enableAutoSave) return;

    // Clear existing timer
    if (autoSaveTimerRef.current) {
      clearInterval(autoSaveTimerRef.current);
    }

    // Setup auto-save timer
    autoSaveTimerRef.current = setInterval(() => {
      if (pendingDataRef.current && isPending) {
        saveDraft(pendingDataRef.current);
        pendingDataRef.current = null;
      }
    }, autoSaveInterval);

    return () => {
      if (autoSaveTimerRef.current) {
        clearInterval(autoSaveTimerRef.current);
      }
    };
  }, [enableAutoSave, autoSaveInterval, isPending, saveDraft]);

  /**
   * Enhanced saveDraft that queues for auto-save
   */
  const queuedSaveDraft = useCallback(
    (data: T) => {
      pendingDataRef.current = data;
      setIsPending(true);

      // If auto-save is disabled, save immediately
      if (!enableAutoSave) {
        saveDraft(data);
      }
    },
    [enableAutoSave, saveDraft]
  );

  return {
    saveDraft: queuedSaveDraft,
    loadDraft,
    hasDraft,
    clearDraft,
    isPending,
    lastSaved,
    draftAge,
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Format draft age in human-readable format
 */
function formatDraftAge(savedAt: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - savedAt.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) {
    return 'Just now';
  }
  if (diffMinutes < 60) {
    return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`;
  }
  if (diffHours < 24) {
    return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  }
  return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
}

/**
 * Get all draft keys for a specific report type
 */
export function getAllDraftKeys(reportType?: ReportType): string[] {
  const keys: string[] = [];
  const prefix = reportType
    ? `${DRAFT_KEY_PREFIX}${reportType}_`
    : DRAFT_KEY_PREFIX;

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(prefix)) {
      keys.push(key);
    }
  }

  return keys;
}

/**
 * Clear all drafts (useful for logout or cleanup)
 */
export function clearAllDrafts(reportType?: ReportType): void {
  const keys = getAllDraftKeys(reportType);
  keys.forEach((key) => {
    localStorage.removeItem(key);
  });
}

export default useReportDraft;
