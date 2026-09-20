/**
 * ConsentBanner Component
 *
 * Displays a banner when the user's consent preferences are outdated
 * or when consent has not been recorded yet. Appears after login
 * and allows users to quickly update their consent preferences.
 *
 * GDPR Article 7: Consent must be freely given, specific, informed, and unambiguous.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal, useAuthContext } from '@aquaculture/shared-ui';
import useConsent, { CONSENT_TYPE_LABELS, type ConsentType } from '../hooks/useConsent';
import { ShieldCheck } from 'lucide-react';

/**
 * GDPR Article 7: the gate has no dismissal path — no close control, no
 * Escape, no overlay click — so the only way out is one of the consent
 * actions. Modal still requires an onClose; it is never reached.
 */
const noDismiss = (): void => undefined;

const ConsentBanner: React.FC = () => {
  const { isAuthenticated } = useAuthContext();
  const navigate = useNavigate();
  const {
    status,
    isStatusLoading,
    statusError,
    isOutdated,
    isOutdatedLoading,
    recordBulkConsent,
    isBulkRecording,
  } = useConsent();

  /**
   * Persist dismissal in localStorage so the banner does not reappear on
   * every route transition. The key includes a version suffix so that a
   * future consent-version bump can resurface the banner automatically.
   */
  const DISMISSED_KEY = 'consent_banner_dismissed';

  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [expanded, setExpanded] = useState(false);
  const [localConsents, setLocalConsents] = useState<Record<ConsentType, boolean>>(
    {} as Record<ConsentType, boolean>,
  );

  /**
   * GDPR compliance: When the server reports that consent is outdated
   * (e.g. a new consent version was published), clear the localStorage
   * dismissal flag so the banner resurfaces for the user to re-consent.
   * This ensures users always see the banner when their consent becomes
   * stale, even if they previously dismissed it.
   */
  useEffect(() => {
    if (isOutdated) {
      try {
        localStorage.removeItem(DISMISSED_KEY);
      } catch {
        // Ignore localStorage errors
      }
      setDismissed(false);
    }
  }, [isOutdated, DISMISSED_KEY]);

  // Initialize local consent state from server status
  useEffect(() => {
    if (status?.consents) {
      const consentMap: Record<string, boolean> = {};
      for (const c of status.consents) {
        consentMap[c.consentType] = c.granted;
      }
      setLocalConsents(consentMap as Record<ConsentType, boolean>);
    }
  }, [status]);

  // Determine if banner should show
  // If consent queries fail (e.g. resolver not reachable), don't block the user
  const shouldShow =
    isAuthenticated &&
    !dismissed &&
    !isOutdatedLoading &&
    !isStatusLoading &&
    !statusError &&
    (isOutdated || (status && status.consents.length === 0));

  /**
   * Persists the dismissed flag both in React state and in localStorage.
   * Called by all three consent action handlers so the banner stays hidden
   * across SPA navigations and full page reloads.
   */
  const persistDismissal = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISSED_KEY, 'true');
    } catch {
      // localStorage unavailable -- the in-memory flag is enough for this session
    }
  }, [DISMISSED_KEY]);

  const handleAcceptAll = useCallback(async () => {
    const allConsentTypes: ConsentType[] = [
      'ESSENTIAL',
      'DATA_PROCESSING',
      'ANALYTICS',
      'MARKETING',
      'THIRD_PARTY',
      'DATA_SHARING',
      'PROFILING',
    ];

    try {
      await recordBulkConsent(allConsentTypes.map((ct) => ({ consentType: ct, granted: true })));
    } catch {
      // Don't block the user if consent recording fails
    }
    persistDismissal();
  }, [recordBulkConsent, persistDismissal]);

  const handleSavePreferences = useCallback(async () => {
    const consents = Object.entries(localConsents).map(([consentType, granted]) => ({
      consentType: consentType as ConsentType,
      granted,
    }));

    // Always grant essential
    const hasEssential = consents.find((c) => c.consentType === 'ESSENTIAL');
    if (!hasEssential) {
      consents.push({ consentType: 'ESSENTIAL', granted: true });
    } else {
      hasEssential.granted = true;
    }

    try {
      await recordBulkConsent(consents);
    } catch {
      // Don't block the user if consent recording fails
    }
    persistDismissal();
  }, [localConsents, recordBulkConsent, persistDismissal]);

  const handleEssentialOnly = useCallback(async () => {
    const allConsentTypes: ConsentType[] = [
      'ESSENTIAL',
      'DATA_PROCESSING',
      'ANALYTICS',
      'MARKETING',
      'THIRD_PARTY',
      'DATA_SHARING',
      'PROFILING',
    ];

    try {
      await recordBulkConsent(
        allConsentTypes.map((ct) => ({
          consentType: ct,
          granted: ct === 'ESSENTIAL',
        })),
      );
    } catch {
      // Don't block the user if consent recording fails
    }
    persistDismissal();
  }, [recordBulkConsent, persistDismissal]);

  const handleToggleConsent = useCallback((consentType: ConsentType) => {
    if (consentType === 'ESSENTIAL') return; // Essential cannot be toggled
    setLocalConsents((prev) => ({
      ...prev,
      [consentType]: !prev[consentType],
    }));
  }, []);

  if (!shouldShow) {
    return null;
  }

  const consentTypes: ConsentType[] = [
    'ESSENTIAL',
    'DATA_PROCESSING',
    'ANALYTICS',
    'MARKETING',
    'THIRD_PARTY',
    'DATA_SHARING',
    'PROFILING',
  ];

  return (
    <Modal
      isOpen
      onClose={noDismiss}
      size="lg"
      closeOnEscape={false}
      closeOnOverlayClick={false}
      showCloseButton={false}
      title={
        <span className="flex items-center gap-3">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-info-100 dark:bg-info-900/40">
            <ShieldCheck
              className="h-5 w-5 text-info-600 dark:text-info-400"
              strokeWidth={1.5}
              aria-hidden="true"
            />
          </span>
          {isOutdated ? 'Your Privacy Preferences Need Updating' : 'Privacy Preferences'}
        </span>
      }
      description={
        isOutdated
          ? 'Our privacy policy has been updated. Please review and update your consent preferences to continue using the platform.'
          : 'Please review and set your consent preferences. We respect your privacy and give you control over how your data is used.'
      }
      footer={
        <>
          {expanded ? (
            <button
              type="button"
              onClick={handleSavePreferences}
              disabled={isBulkRecording}
              className="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-info-600 rounded-lg hover:bg-info-700 focus:outline-hidden focus:ring-2 focus:ring-info-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isBulkRecording ? 'Saving...' : 'Save Preferences'}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={handleAcceptAll}
                disabled={isBulkRecording}
                className="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-info-600 rounded-lg hover:bg-info-700 focus:outline-hidden focus:ring-2 focus:ring-info-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isBulkRecording ? 'Saving...' : 'Accept All'}
              </button>
              <button
                type="button"
                onClick={handleEssentialOnly}
                disabled={isBulkRecording}
                className="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 focus:outline-hidden focus:ring-2 focus:ring-info-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Essential Only
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => navigate('/settings/privacy')}
            className="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100 focus:outline-hidden focus:underline"
          >
            Manage in Settings
          </button>
        </>
      }
    >
      {/* Expand/collapse toggle */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="mt-2 text-sm font-medium text-info-600 dark:text-info-400 hover:text-info-700 dark:hover:text-info-200 focus:outline-hidden focus:underline"
      >
        {expanded ? 'Hide details' : 'Customize preferences'}
      </button>

      {/* Expanded consent details */}
      {expanded && (
        <div className="mt-4 space-y-3 max-h-64 overflow-y-auto pr-2">
          {consentTypes.map((ct) => {
            const info = CONSENT_TYPE_LABELS[ct];
            const isEssential = ct === 'ESSENTIAL';
            const isGranted = localConsents[ct] ?? false;

            return (
              <div
                key={ct}
                className="flex items-start gap-3 p-3 rounded-lg bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                {/* Toggle */}
                <button
                  aria-label={info.label}
                  type="button"
                  role="switch"
                  aria-checked={isEssential || isGranted}
                  disabled={isEssential}
                  onClick={() => handleToggleConsent(ct)}
                  className={`
                    relative mt-0.5 inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent
                    transition-colors duration-200 ease-in-out focus:outline-hidden focus:ring-2 focus:ring-info-500 focus:ring-offset-2
                    ${isEssential ? 'bg-info-400 cursor-not-allowed' : isGranted ? 'bg-info-600' : 'bg-gray-300'}
                  `}
                >
                  <span
                    className={`
                      pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white dark:bg-gray-900 shadow ring-0
                      transition duration-200 ease-in-out
                      ${isEssential || isGranted ? 'translate-x-4' : 'translate-x-0'}
                    `}
                  />
                </button>

                {/* Label & description */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {info.label}
                    </span>
                    {isEssential && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-info-100 dark:bg-info-900/40 text-info-700 dark:text-info-300">
                        Required
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {info.description}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
};

export default ConsentBanner;
