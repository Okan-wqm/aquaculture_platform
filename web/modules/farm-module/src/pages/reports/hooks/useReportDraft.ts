/**
 * useReportDraft Hook
 * Manages draft saving/loading for regulatory reports.
 *
 * Provides:
 * - Auto-save draft on form changes
 * - Load existing draft on form open
 * - Clear draft on successful submission
 * - Draft expiry (7 days default)
 *
 * Storage isolation (root-cause of the cross-tenant + survive-logout PII leak
 * class): regulatory report drafts contain PII, so they MUST be (a) scoped to
 * the full tenantId — never a substring(0,8) prefix that can collide between
 * tenants on a shared browser — and (b) swept on logout. Rather than maintain a
 * second, ad-hoc localStorage abstraction, this hook delegates ALL key-scoping
 * and persistence to the platform's single sanctioned accessor
 * `useTenantScopedStorage`, which writes under the `aqua.tss::<tenantId>::`
 * namespace that `logoutCleanup` already sweeps. The version / expiry / shape
 * checks below remain the responsibility of THIS hook (they encode the draft
 * envelope contract, not the storage contract).
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { useAuth, useTenantScopedStorage } from '@aquaculture/shared-ui';
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

const DRAFT_VERSION = 1;
const DEFAULT_EXPIRY_DAYS = 7;
const DEFAULT_AUTO_SAVE_INTERVAL = 5000;

// ============================================================================
// Draft envelope validation (pure — exported for unit tests)
// ============================================================================

/**
 * Narrow an arbitrary stored value to the {@link DraftData} envelope shape.
 * Returns `null` for anything that is not a well-formed draft envelope so the
 * caller can discard (and remove) corrupt / foreign data instead of trusting
 * it. Pure: no React, no storage access — directly unit-testable.
 */
export function isDraftEnvelope(raw: unknown): raw is DraftData<unknown> {
  return (
    raw !== null &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    'version' in raw &&
    'savedAt' in raw &&
    'data' in raw &&
    typeof (raw as { savedAt: unknown }).savedAt === 'string' &&
    typeof (raw as { version: unknown }).version === 'number'
  );
}

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

  // Drafts are per-(tenant, report). The platform's sanctioned accessor adds
  // the `aqua.tss::<tenantId>::` prefix, so two tenants can never collide on a
  // shared browser and the logout sweep clears the PII drafts. The accessor
  // no-ops when no tenant is resolved, so nothing is ever written un-scoped.
  const { tenantId } = useAuth();
  const baseKey = `${reportType}_${reportId || 'new'}`;
  const draftStorage = useTenantScopedStorage<unknown>(baseKey, tenantId);

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
   * Save draft to tenant-scoped storage
   */
  const saveDraft = useCallback(
    (data: T) => {
      const draftData: DraftData<T> = {
        data,
        savedAt: new Date().toISOString(),
        version: DRAFT_VERSION,
      };
      draftStorage.write(draftData);
      setLastSaved(new Date());
      setIsPending(false);
    },
    [draftStorage]
  );

  /**
   * Load draft from tenant-scoped storage
   */
  const loadDraft = useCallback((): DraftData<T> | null => {
    const raw = draftStorage.read();

    // HIGH-04: validate envelope shape before trusting stored data.
    if (!isDraftEnvelope(raw)) {
      if (raw !== null) draftStorage.remove();
      return null;
    }

    // The envelope is validated; the payload `data` carries the caller's T.
    const parsed = raw as DraftData<T>;

    // Check version compatibility
    if (parsed.version !== DRAFT_VERSION) {
      draftStorage.remove();
      return null;
    }

    // Check expiry
    if (isDraftExpired(parsed.savedAt)) {
      draftStorage.remove();
      return null;
    }

    setLastSaved(new Date(parsed.savedAt));
    return parsed;
  }, [draftStorage, isDraftExpired]);

  /**
   * Check if draft exists
   */
  const hasDraft = useCallback((): boolean => {
    const raw = draftStorage.read();
    if (!isDraftEnvelope(raw)) return false;
    return !isDraftExpired(raw.savedAt);
  }, [draftStorage, isDraftExpired]);

  /**
   * Clear draft from tenant-scoped storage
   */
  const clearDraft = useCallback(() => {
    draftStorage.remove();
    setLastSaved(null);
    setIsPending(false);
    pendingDataRef.current = null;
  }, [draftStorage]);

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

export default useReportDraft;
