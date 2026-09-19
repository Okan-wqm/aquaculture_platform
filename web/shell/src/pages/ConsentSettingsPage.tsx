/**
 * ConsentSettingsPage
 *
 * Full GDPR consent management page accessible from Settings > Privacy.
 * Users can:
 * - View their current consent status for each consent type
 * - Toggle individual consents on/off
 * - View their complete consent history with timestamps
 * - See the current consent policy version
 *
 * GDPR Compliance:
 * - Article 7: Clear, affirmative consent actions
 * - Article 15: Right of access to consent records
 * - Article 7(3): Right to withdraw consent at any time
 */

import React, { useState, useCallback } from 'react';
import useConsent, {
  useConsentHistory,
  CONSENT_TYPE_LABELS,
  type ConsentType,
  type UserConsentRecord,
} from '../hooks/useConsent';
import { DataTable, type DataTableColumn, Spinner, PageHeader } from '@aquaculture/shared-ui';
import { Check, CircleAlert, CircleCheck, FileText, TriangleAlert } from 'lucide-react';

// ============================================================================
// Sub-components
// ============================================================================

/**
 * Individual consent toggle card
 */
const ConsentCard: React.FC<{
  consentType: ConsentType;
  granted: boolean;
  isLoading: boolean;
  onToggle: (consentType: ConsentType, granted: boolean) => void;
}> = ({ consentType, granted, isLoading, onToggle }) => {
  const info = CONSENT_TYPE_LABELS[consentType];
  const isEssential = consentType === 'ESSENTIAL';

  return (
    <div className="flex items-start gap-4 p-4 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-500 transition-colors">
      {/* Toggle switch */}
      <button
        type="button"
        role="switch"
        aria-checked={isEssential || granted}
        aria-label={`Toggle ${info.label}`}
        disabled={isEssential || isLoading}
        onClick={() => onToggle(consentType, !granted)}
        className={`
          relative mt-0.5 inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent
          transition-colors duration-200 ease-in-out focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:ring-offset-2
          ${isEssential ? 'bg-blue-400 cursor-not-allowed opacity-75' : granted ? 'bg-blue-600' : 'bg-gray-300'}
          ${isLoading ? 'opacity-50 cursor-wait' : ''}
        `}
      >
        <span
          className={`
            pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white dark:bg-gray-900 shadow ring-0
            transition duration-200 ease-in-out
            ${isEssential || granted ? 'translate-x-5' : 'translate-x-0'}
          `}
        />
      </button>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{info.label}</h4>
          {isEssential && (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700">
              Required
            </span>
          )}
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
              isEssential || granted
                ? 'bg-green-100 text-green-700'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
            }`}
          >
            {isEssential || granted ? 'Granted' : 'Denied'}
          </span>
        </div>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{info.description}</p>
      </div>
    </div>
  );
};

/**
 * Consent history table row
 */
const consentHistoryColumns: DataTableColumn<UserConsentRecord>[] = [
  {
    key: 'consentType',
    header: 'Consent Type',
    render: (_value, record) => (
      <span className="whitespace-nowrap text-gray-900 dark:text-gray-100">
        {CONSENT_TYPE_LABELS[record.consentType]?.label ?? record.consentType}
      </span>
    ),
  },
  {
    key: 'granted',
    header: 'Action',
    render: (_value, record) => (
      <span
        className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
          record.granted ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
        }`}
      >
        {record.granted ? 'Granted' : 'Denied / Withdrawn'}
      </span>
    ),
  },
  {
    key: 'version',
    header: 'Version',
    render: (_value, record) => (
      <span className="whitespace-nowrap text-gray-500 dark:text-gray-400">v{record.version}</span>
    ),
  },
  {
    key: 'createdAt',
    header: 'Date',
    render: (_value, record) => (
      <span className="whitespace-nowrap text-gray-500 dark:text-gray-400">
        {new Date(record.createdAt).toLocaleString()}
      </span>
    ),
  },
  {
    key: 'isActive',
    header: 'Status',
    render: (_value, record) =>
      record.isActive ? (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700">
          Active
        </span>
      ) : (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400">
          Superseded
        </span>
      ),
  },
];

// ============================================================================
// Main Page Component
// ============================================================================

const ConsentSettingsPage: React.FC = () => {
  const {
    status,
    isStatusLoading,
    statusError,
    currentVersion,
    isOutdated,
    toggleConsent,
    isMutating,
    refetchStatus,
  } = useConsent();

  // History pagination
  const [historyPage, setHistoryPage] = useState(0);
  const historyLimit = 10;
  const historyQuery = useConsentHistory(historyLimit, historyPage * historyLimit);

  // Track which consent type is currently being toggled
  const [togglingType, setTogglingType] = useState<ConsentType | null>(null);

  const handleToggle = useCallback(
    async (consentType: ConsentType, granted: boolean) => {
      setTogglingType(consentType);
      try {
        await toggleConsent(consentType, granted);
      } catch {
        // Mutation error state is handled by the hook
      } finally {
        setTogglingType(null);
      }
    },
    [toggleConsent],
  );

  // Build consent map from status
  const consentMap: Record<string, boolean> = {};
  if (status?.consents) {
    for (const c of status.consents) {
      consentMap[c.consentType] = c.granted;
    }
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
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Page Header */}
      <PageHeader
        title="Privacy & Consent"
        description="Manage your data privacy preferences. You have full control over how your data is processed and shared."
      />

      {/* Outdated Warning */}
      {isOutdated && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 p-4">
          <div className="flex items-start gap-3">
            <TriangleAlert
              className="h-5 w-5 text-amber-500 mt-0.5 flex-shrink-0"
              strokeWidth={1.5}
              aria-hidden="true"
            />
            <div>
              <h3 className="text-sm font-semibold text-amber-800">Consent Update Required</h3>
              <p className="mt-1 text-sm text-amber-700">
                Our privacy policy has been updated. Please review your consent preferences below to
                ensure they reflect your current choices.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Version & Status Info */}
      <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Consent Status
            </h2>
            <div className="mt-1 flex items-center gap-4 text-sm text-gray-500 dark:text-gray-400">
              {currentVersion && (
                <span>
                  Policy Version:{' '}
                  <span className="font-medium text-gray-700 dark:text-gray-300">
                    v{currentVersion}
                  </span>
                </span>
              )}
              {status?.lastUpdated && (
                <span>
                  Last Updated:{' '}
                  <span className="font-medium text-gray-700 dark:text-gray-300">
                    {new Date(status.lastUpdated).toLocaleDateString()}
                  </span>
                </span>
              )}
            </div>
          </div>
          <div>
            {status && !isOutdated && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium bg-green-100 text-green-700">
                <Check className="h-4 w-4" aria-hidden="true" />
                Up to Date
              </span>
            )}
            {isOutdated && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium bg-amber-100 text-amber-700">
                <TriangleAlert className="h-4 w-4" aria-hidden="true" />
                Update Required
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Loading State */}
      {isStatusLoading && (
        <div className="flex justify-center py-12">
          <div className="flex items-center gap-3 text-gray-500 dark:text-gray-400">
            <Spinner size="md" color="inherit" />
            <span className="text-sm">Loading consent preferences...</span>
          </div>
        </div>
      )}

      {/* Error State */}
      {statusError && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-4">
          <div className="flex items-start gap-3">
            <CircleAlert
              className="h-5 w-5 text-red-500 mt-0.5 flex-shrink-0"
              strokeWidth={1.5}
              aria-hidden="true"
            />
            <div>
              <h3 className="text-sm font-semibold text-red-800">
                Failed to load consent preferences
              </h3>
              <p className="mt-1 text-sm text-red-700">
                {statusError instanceof Error
                  ? statusError.message
                  : 'An unexpected error occurred.'}
              </p>
              <button
                type="button"
                onClick={() => refetchStatus()}
                className="mt-2 text-sm font-medium text-red-700 hover:text-red-800 underline"
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Consent Toggles */}
      {status && !isStatusLoading && (
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            Your Consent Preferences
          </h2>
          <div className="space-y-3">
            {consentTypes.map((ct) => (
              <ConsentCard
                key={ct}
                consentType={ct}
                granted={consentMap[ct] ?? false}
                isLoading={isMutating && togglingType === ct}
                onToggle={handleToggle}
              />
            ))}
          </div>
        </div>
      )}

      {/* GDPR Rights Information */}
      <div className="bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-5">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
          Your Data Rights (GDPR)
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="flex items-start gap-2">
            <CircleCheck
              className="h-4 w-4 text-blue-500 mt-0.5 flex-shrink-0"
              strokeWidth={1.5}
              aria-hidden="true"
            />
            <div>
              <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
                Right to Access
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                View all consent records and history
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <CircleCheck
              className="h-4 w-4 text-blue-500 mt-0.5 flex-shrink-0"
              strokeWidth={1.5}
              aria-hidden="true"
            />
            <div>
              <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
                Right to Withdraw
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Withdraw any non-essential consent at any time
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <CircleCheck
              className="h-4 w-4 text-blue-500 mt-0.5 flex-shrink-0"
              strokeWidth={1.5}
              aria-hidden="true"
            />
            <div>
              <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
                Right to Information
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Clear descriptions of each data processing purpose
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <CircleCheck
              className="h-4 w-4 text-blue-500 mt-0.5 flex-shrink-0"
              strokeWidth={1.5}
              aria-hidden="true"
            />
            <div>
              <p className="text-xs font-medium text-gray-700 dark:text-gray-300">Audit Trail</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Complete history of all consent changes
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Consent History */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Consent History
        </h2>

        {historyQuery.isLoading && (
          <div className="flex justify-center py-8">
            <div className="flex items-center gap-3 text-gray-500 dark:text-gray-400">
              <Spinner size="md" color="inherit" />
              <span className="text-sm">Loading history...</span>
            </div>
          </div>
        )}

        {historyQuery.error && (
          <div className="rounded-lg bg-red-50 border border-red-200 p-4">
            <p className="text-sm text-red-700">
              Failed to load consent history.{' '}
              <button
                type="button"
                onClick={() => historyQuery.refetch()}
                className="font-medium underline hover:text-red-800"
              >
                Try again
              </button>
            </p>
          </div>
        )}

        {historyQuery.data && (
          <>
            {historyQuery.data.records.length === 0 ? (
              <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-8 text-center">
                <FileText
                  className="mx-auto h-10 w-10 text-gray-300"
                  strokeWidth={1.5}
                  aria-hidden="true"
                />
                <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                  No consent history found.
                </p>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                  Consent records will appear here as you update your preferences.
                </p>
              </div>
            ) : (
              <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                <DataTable<UserConsentRecord>
                  data={historyQuery.data.records}
                  columns={consentHistoryColumns}
                  keyExtractor={(record) => record.id}
                  emptyMessage="No consent history"
                  searchable={false}
                  sortable={false}
                  stickyHeader={false}
                  className="border-0 rounded-none shadow-none"
                />

                {/* Pagination */}
                {historyQuery.data.totalCount > historyLimit && (
                  <div className="flex items-center justify-between px-4 py-3 bg-gray-50 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700">
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Showing {historyPage * historyLimit + 1} to{' '}
                      {Math.min((historyPage + 1) * historyLimit, historyQuery.data.totalCount)} of{' '}
                      {historyQuery.data.totalCount} records
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={historyPage === 0}
                        onClick={() => setHistoryPage((p) => Math.max(0, p - 1))}
                        className="px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Previous
                      </button>
                      <button
                        type="button"
                        disabled={(historyPage + 1) * historyLimit >= historyQuery.data.totalCount}
                        onClick={() => setHistoryPage((p) => p + 1)}
                        className="px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default ConsentSettingsPage;
