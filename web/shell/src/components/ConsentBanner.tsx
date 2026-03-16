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
import { useAuthContext } from '@aquaculture/shared-ui';
import useConsent, { CONSENT_TYPE_LABELS, type ConsentType } from '../hooks/useConsent';

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

  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [localConsents, setLocalConsents] = useState<Record<ConsentType, boolean>>({} as Record<ConsentType, boolean>);

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
      await recordBulkConsent(
        allConsentTypes.map((ct) => ({ consentType: ct, granted: true })),
      );
    } catch {
      // Don't block the user if consent recording fails
    }
    setDismissed(true);
  }, [recordBulkConsent]);

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
    setDismissed(true);
  }, [localConsents, recordBulkConsent]);

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
    setDismissed(true);
  }, [recordBulkConsent]);

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
    <div className="fixed inset-x-0 bottom-0 z-50">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/20 backdrop-blur-sm" />

      {/* Banner */}
      <div className="relative bg-white border-t border-gray-200 shadow-2xl">
        <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6 lg:px-8">
          {/* Header row */}
          <div className="flex items-start gap-4">
            {/* Shield icon */}
            <div className="flex-shrink-0 mt-0.5">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100">
                <svg
                  className="h-5 w-5 text-blue-600"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
                  />
                </svg>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <h3 className="text-base font-semibold text-gray-900">
                {isOutdated
                  ? 'Your Privacy Preferences Need Updating'
                  : 'Privacy Preferences'}
              </h3>
              <p className="mt-1 text-sm text-gray-600">
                {isOutdated
                  ? 'Our privacy policy has been updated. Please review and update your consent preferences to continue using the platform.'
                  : 'Please review and set your consent preferences. We respect your privacy and give you control over how your data is used.'}
              </p>

              {/* Expand/collapse toggle */}
              <button
                type="button"
                onClick={() => setExpanded(!expanded)}
                className="mt-2 text-sm font-medium text-blue-600 hover:text-blue-700 focus:outline-none focus:underline"
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
                        className="flex items-start gap-3 p-3 rounded-lg bg-gray-50 hover:bg-gray-100 transition-colors"
                      >
                        {/* Toggle */}
                        <button
                          type="button"
                          role="switch"
                          aria-checked={isEssential || isGranted}
                          disabled={isEssential}
                          onClick={() => handleToggleConsent(ct)}
                          className={`
                            relative mt-0.5 inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent
                            transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2
                            ${isEssential ? 'bg-blue-400 cursor-not-allowed' : isGranted ? 'bg-blue-600' : 'bg-gray-300'}
                          `}
                        >
                          <span
                            className={`
                              pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0
                              transition duration-200 ease-in-out
                              ${(isEssential || isGranted) ? 'translate-x-4' : 'translate-x-0'}
                            `}
                          />
                        </button>

                        {/* Label & description */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-gray-900">
                              {info.label}
                            </span>
                            {isEssential && (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700">
                                Required
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-gray-500 mt-0.5">{info.description}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Action buttons */}
            <div className="flex-shrink-0 flex flex-col sm:flex-row gap-2">
              {expanded ? (
                <button
                  type="button"
                  onClick={handleSavePreferences}
                  disabled={isBulkRecording}
                  className="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isBulkRecording ? 'Saving...' : 'Save Preferences'}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={handleAcceptAll}
                    disabled={isBulkRecording}
                    className="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isBulkRecording ? 'Saving...' : 'Accept All'}
                  </button>
                  <button
                    type="button"
                    onClick={handleEssentialOnly}
                    disabled={isBulkRecording}
                    className="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Essential Only
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => navigate('/settings/privacy')}
                className="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700 focus:outline-none focus:underline"
              >
                Manage in Settings
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConsentBanner;
