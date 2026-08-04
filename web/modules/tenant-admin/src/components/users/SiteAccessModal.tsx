import React, { useEffect, useId, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, MapPin, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { getSessionSnapshot, hasSameTenantSessionBoundary, useAuth } from '@aquaculture/shared-ui';

import {
  canManageUserSiteAccess,
  SiteAccessSessionChangedError,
  useActiveTenantSites,
  useAssignUserToSite,
  useUnassignUserFromSite,
  useUserAssignedSiteIds,
  userSiteAccessKeys,
} from '../../hooks/useUserSiteAccess';
import { sanitizeErrorMessage } from '../../utils/error-handling';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import type { DisplayUser } from './UserListSection';

interface SiteAccessModalProps {
  isOpen: boolean;
  onClose: () => void;
  user: DisplayUser | null;
}

interface PendingSiteAction {
  kind: 'assign' | 'unassign';
  site: SiteAccessDisplayItem;
  ownerQueryKey: readonly unknown[];
  ownerTargetUserId: string;
}

interface SiteAccessFeedback {
  kind: 'error' | 'success';
  message: string;
  retryAssignments: boolean;
  ownerQueryKey: readonly unknown[];
  ownerTargetUserId: string;
}

interface SiteAccessDisplayItem {
  id: string;
  name: string;
  code: string;
  availableForAssignment: boolean;
}

function hasCurrentSiteAccessSession(
  ownerQueryKey: readonly unknown[],
  ownerTargetUserId: string,
  currentTargetUserId: string,
): boolean {
  if (ownerTargetUserId !== currentTargetUserId) return false;
  const currentSession = getSessionSnapshot();
  const currentQueryKey = userSiteAccessKeys.assignments(
    currentSession.effectiveTenantId,
    currentTargetUserId,
  );
  return hasSameTenantSessionBoundary(ownerQueryKey, currentQueryKey);
}

export const SiteAccessModal: React.FC<SiteAccessModalProps> = ({ isOpen, onClose, user }) => {
  const { tenantId, token, user: currentUser } = useAuth();
  const targetUserId = user ? user.id : '';
  const targetIsModuleUser = user ? user.role === 'MODULE_USER' : false;
  const isAuthorized = canManageUserSiteAccess(currentUser?.role);
  const hasTenantSession = Boolean(tenantId && token);
  const dialogIsOpen = isOpen && targetIsModuleUser && isAuthorized;
  const shouldLoad = dialogIsOpen && hasTenantSession;

  const sitesQuery = useActiveTenantSites(shouldLoad);
  const assignmentsQuery = useUserAssignedSiteIds(targetUserId, shouldLoad);
  const assignMutation = useAssignUserToSite();
  const unassignMutation = useUnassignUserFromSite();

  const [pendingAction, setPendingAction] = useState<PendingSiteAction | null>(null);
  const [confirmationError, setConfirmationError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<SiteAccessFeedback | null>(null);
  const [isReloadingAfterSave, setIsReloadingAfterSave] = useState(false);
  const [sessionBoundaryMessage, setSessionBoundaryMessage] = useState<string | null>(null);

  const operationPending =
    assignMutation.isPending || unassignMutation.isPending || isReloadingAfterSave;

  const titleId = useId();
  const descriptionId = useId();

  const handleClose = (): void => {
    if (operationPending) return;
    setPendingAction(null);
    setConfirmationError(null);
    setFeedback(null);
    setSessionBoundaryMessage(null);
    onClose();
  };

  const { containerRef, handleKeyDown } = useFocusTrap({
    isOpen: dialogIsOpen,
    onClose: handleClose,
    closeOnEscape: !operationPending,
    autoFocus: true,
    restoreFocus: true,
  });

  useEffect(() => {
    setPendingAction(null);
    setConfirmationError(null);
    setFeedback(null);
    setSessionBoundaryMessage(null);
    setIsReloadingAfterSave(false);
  }, [isOpen]);

  const assignedSiteIds = useMemo(
    () => new Set(assignmentsQuery.data ?? []),
    [assignmentsQuery.data],
  );
  const displaySites = useMemo<SiteAccessDisplayItem[]>(() => {
    const activeSites = (sitesQuery.data ?? []).map((site) => ({
      id: site.id,
      name: site.name,
      code: site.code,
      availableForAssignment: true,
    }));
    const activeIds = new Set(activeSites.map((site) => site.id));
    const unavailableAssignments = (assignmentsQuery.data ?? [])
      .filter((siteId) => !activeIds.has(siteId))
      .sort()
      .map((siteId) => ({
        id: siteId,
        name: 'Unavailable site assignment',
        code: siteId,
        availableForAssignment: false,
      }));
    return [...activeSites, ...unavailableAssignments];
  }, [assignmentsQuery.data, sitesQuery.data]);
  const unavailableAssignmentCount = displaySites.filter(
    (site) => !site.availableForAssignment,
  ).length;

  const pendingActionIsCurrent =
    pendingAction === null ||
    hasCurrentSiteAccessSession(
      pendingAction.ownerQueryKey,
      pendingAction.ownerTargetUserId,
      targetUserId,
    );
  const visiblePendingAction = pendingActionIsCurrent ? pendingAction : null;
  const feedbackIsCurrent =
    feedback === null ||
    hasCurrentSiteAccessSession(feedback.ownerQueryKey, feedback.ownerTargetUserId, targetUserId);
  const visibleFeedback = feedbackIsCurrent ? feedback : null;
  const synchronousBoundaryMessage =
    sessionBoundaryMessage ??
    (!pendingActionIsCurrent || !feedbackIsCurrent
      ? new SiteAccessSessionChangedError().message
      : null);

  if (!isOpen || !user || !targetIsModuleUser || !isAuthorized) return null;

  const missingSites = sitesQuery.data === undefined;
  const missingAssignments = assignmentsQuery.data === undefined;
  const isInitialLoading =
    (missingSites && (sitesQuery.isPending || sitesQuery.isFetching)) ||
    (missingAssignments && (assignmentsQuery.isPending || assignmentsQuery.isFetching));
  const blockingQueryError =
    (missingSites && sitesQuery.isError) || (missingAssignments && assignmentsQuery.isError);
  const queryError = sitesQuery.error ?? assignmentsQuery.error;
  const handleRetryAll = async (): Promise<void> => {
    setFeedback(null);
    await Promise.all([sitesQuery.refetch(), assignmentsQuery.refetch()]);
  };

  const handleRetryAssignments = async (): Promise<void> => {
    const ownerQueryKey = visibleFeedback?.ownerQueryKey;
    const ownerTargetUserId = visibleFeedback?.ownerTargetUserId;
    if (
      !ownerQueryKey ||
      !ownerTargetUserId ||
      !hasCurrentSiteAccessSession(ownerQueryKey, ownerTargetUserId, user.id)
    ) {
      setFeedback(null);
      setSessionBoundaryMessage(new SiteAccessSessionChangedError().message);
      return;
    }

    const refreshed = await assignmentsQuery.refetch();
    if (!hasCurrentSiteAccessSession(ownerQueryKey, ownerTargetUserId, user.id)) {
      setFeedback(null);
      setSessionBoundaryMessage(new SiteAccessSessionChangedError().message);
      return;
    }
    if (refreshed.isError) {
      setFeedback({
        kind: 'error',
        message:
          'The change was saved, but the current site access could not be reloaded. Retry before making another change.',
        retryAssignments: true,
        ownerQueryKey,
        ownerTargetUserId,
      });
      return;
    }
    setFeedback(null);
  };

  const openConfirmation = (kind: PendingSiteAction['kind'], site: SiteAccessDisplayItem): void => {
    setConfirmationError(null);
    setFeedback(null);
    setPendingAction({
      kind,
      site,
      ownerQueryKey: userSiteAccessKeys.assignments(tenantId, user.id),
      ownerTargetUserId: user.id,
    });
  };

  const cancelConfirmation = (): void => {
    if (operationPending) return;
    setPendingAction(null);
    setConfirmationError(null);
  };

  const handleConfirm = async (): Promise<void> => {
    if (!pendingAction) return;

    if (
      !hasCurrentSiteAccessSession(
        pendingAction.ownerQueryKey,
        pendingAction.ownerTargetUserId,
        user.id,
      )
    ) {
      setPendingAction(null);
      setSessionBoundaryMessage(new SiteAccessSessionChangedError().message);
      return;
    }

    setConfirmationError(null);
    const action = pendingAction;
    const ownerQueryKey = action.ownerQueryKey;
    const ownerTargetUserId = action.ownerTargetUserId;
    let successMessage: string;

    try {
      const result =
        action.kind === 'assign'
          ? await assignMutation.mutateAsync({
              userId: ownerTargetUserId,
              siteId: action.site.id,
            })
          : await unassignMutation.mutateAsync({
              userId: ownerTargetUserId,
              siteId: action.site.id,
            });
      successMessage = result.message;
    } catch (error) {
      if (
        error instanceof SiteAccessSessionChangedError ||
        !hasCurrentSiteAccessSession(ownerQueryKey, ownerTargetUserId, user.id)
      ) {
        setPendingAction(null);
        setSessionBoundaryMessage(
          error instanceof SiteAccessSessionChangedError
            ? error.message
            : new SiteAccessSessionChangedError().message,
        );
        return;
      }
      setConfirmationError(sanitizeErrorMessage(error));
      return;
    }

    if (!hasCurrentSiteAccessSession(ownerQueryKey, ownerTargetUserId, user.id)) {
      setPendingAction(null);
      setSessionBoundaryMessage(new SiteAccessSessionChangedError().message);
      return;
    }

    setIsReloadingAfterSave(true);
    try {
      const refreshed = await assignmentsQuery.refetch();
      if (!hasCurrentSiteAccessSession(ownerQueryKey, ownerTargetUserId, user.id)) {
        setSessionBoundaryMessage(new SiteAccessSessionChangedError().message);
      } else if (refreshed.isError) {
        setFeedback({
          kind: 'error',
          message:
            'The change was saved, but the current site access could not be reloaded. Retry before making another change.',
          retryAssignments: true,
          ownerQueryKey,
          ownerTargetUserId,
        });
      } else {
        setFeedback({
          kind: 'success',
          message: successMessage,
          retryAssignments: false,
          ownerQueryKey,
          ownerTargetUserId,
        });
      }
    } catch {
      if (!hasCurrentSiteAccessSession(ownerQueryKey, ownerTargetUserId, user.id)) {
        setSessionBoundaryMessage(new SiteAccessSessionChangedError().message);
      } else {
        setFeedback({
          kind: 'error',
          message:
            'The change was saved, but the current site access could not be reloaded. Retry before making another change.',
          retryAssignments: true,
          ownerQueryKey,
          ownerTargetUserId,
        });
      }
    } finally {
      setIsReloadingAfterSave(false);
      setPendingAction(null);
    }
  };

  const confirmationIsAssignment = visiblePendingAction?.kind === 'assign';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="presentation">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={handleClose}
        aria-hidden="true"
      />

      <div
        ref={containerRef}
        onKeyDown={handleKeyDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="relative flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-gray-100 px-6 py-5">
          <div>
            <h2 id={titleId} className="text-lg font-semibold text-gray-900">
              Site access for {user.name}
            </h2>
            <p id={descriptionId} className="mt-1 text-sm text-gray-500">
              Choose which active farm sites this user can access.
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={operationPending}
            aria-label="Close site access dialog"
            className="rounded-lg p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        {synchronousBoundaryMessage ? (
          <div className="space-y-4 px-6 py-8">
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4" role="alert">
              <div className="flex items-start gap-3">
                <AlertCircle
                  className="mt-0.5 h-5 w-5 flex-none text-amber-600"
                  aria-hidden="true"
                />
                <div>
                  <p className="text-sm font-medium text-amber-900">Tenant session changed</p>
                  <p className="mt-1 text-sm text-amber-800">{synchronousBoundaryMessage}</p>
                </div>
              </div>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleClose}
                className="rounded-lg bg-tenant-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-tenant-700"
              >
                Close
              </button>
            </div>
          </div>
        ) : visiblePendingAction ? (
          <div className="px-6 py-8" aria-live="polite">
            <div className="mx-auto max-w-lg text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-tenant-100">
                <ShieldCheck className="h-6 w-6 text-tenant-700" aria-hidden="true" />
              </div>
              <h3 className="mt-4 text-lg font-semibold text-gray-900">
                {confirmationIsAssignment ? 'Assign site access?' : 'Remove site access?'}
              </h3>
              <p className="mt-2 text-sm text-gray-600">
                {confirmationIsAssignment
                  ? `${user.name} will be able to view data for ${visiblePendingAction.site.name}.`
                  : `${user.name} will no longer be able to view data for ${visiblePendingAction.site.name}.`}
              </p>
            </div>

            {confirmationError && (
              <div
                className="mt-5 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
                role="alert"
              >
                {confirmationError}
              </div>
            )}

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={cancelConfirmation}
                disabled={operationPending}
                autoFocus
                className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={operationPending}
                className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  confirmationIsAssignment
                    ? 'bg-tenant-600 hover:bg-tenant-700'
                    : 'bg-red-600 hover:bg-red-700'
                }`}
              >
                {operationPending && (
                  <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                )}
                {isReloadingAfterSave
                  ? 'Reloading access...'
                  : confirmationIsAssignment
                    ? 'Confirm assignment'
                    : 'Confirm removal'}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto px-6 py-5">
              {!hasTenantSession ? (
                <div className="rounded-xl border border-red-200 bg-red-50 p-4" role="alert">
                  <p className="text-sm font-medium text-red-800">Tenant session unavailable</p>
                  <p className="mt-1 text-sm text-red-700">
                    Re-open this user after selecting a tenant.
                  </p>
                </div>
              ) : isInitialLoading ? (
                <div
                  className="flex items-center justify-center gap-3 py-12 text-sm text-gray-600"
                  role="status"
                  aria-live="polite"
                >
                  <RefreshCw className="h-5 w-5 animate-spin text-tenant-600" aria-hidden="true" />
                  Loading site access...
                </div>
              ) : blockingQueryError ? (
                <div className="rounded-xl border border-red-200 bg-red-50 p-4" role="alert">
                  <div className="flex items-start gap-3">
                    <AlertCircle
                      className="mt-0.5 h-5 w-5 flex-none text-red-600"
                      aria-hidden="true"
                    />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-red-800">
                        Site access could not be loaded
                      </p>
                      <p className="mt-1 text-sm text-red-700">
                        {queryError
                          ? sanitizeErrorMessage(queryError)
                          : 'Please retry the request.'}
                      </p>
                      <button
                        type="button"
                        onClick={handleRetryAll}
                        disabled={sitesQuery.isFetching || assignmentsQuery.isFetching}
                        className="mt-3 inline-flex items-center gap-2 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 transition-colors hover:bg-red-100 disabled:opacity-50"
                      >
                        {(sitesQuery.isFetching || assignmentsQuery.isFetching) && (
                          <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                        )}
                        Retry
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {visibleFeedback && (
                    <div
                      className={`rounded-lg border p-3 ${
                        visibleFeedback.kind === 'success'
                          ? 'border-green-200 bg-green-50 text-green-800'
                          : 'border-amber-200 bg-amber-50 text-amber-800'
                      }`}
                      role={visibleFeedback.kind === 'error' ? 'alert' : 'status'}
                      aria-live="polite"
                    >
                      <div className="flex items-start gap-3">
                        {visibleFeedback.kind === 'success' ? (
                          <CheckCircle2
                            className="mt-0.5 h-5 w-5 flex-none text-green-600"
                            aria-hidden="true"
                          />
                        ) : (
                          <AlertCircle
                            className="mt-0.5 h-5 w-5 flex-none text-amber-600"
                            aria-hidden="true"
                          />
                        )}
                        <div className="flex-1">
                          <p className="text-sm">{visibleFeedback.message}</p>
                          {visibleFeedback.retryAssignments && (
                            <button
                              type="button"
                              onClick={handleRetryAssignments}
                              disabled={assignmentsQuery.isFetching}
                              className="mt-2 inline-flex items-center gap-2 rounded-lg border border-amber-200 bg-white px-3 py-1.5 text-sm font-medium text-amber-800 transition-colors hover:bg-amber-100 disabled:opacity-50"
                            >
                              {assignmentsQuery.isFetching && (
                                <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                              )}
                              Retry access reload
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {unavailableAssignmentCount > 0 && (
                    <div
                      className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
                      role="status"
                    >
                      {unavailableAssignmentCount} existing site assignment
                      {unavailableAssignmentCount === 1 ? ' is' : 's are'} no longer in the active
                      farm catalog. It remains visible here only so you can remove it.
                    </div>
                  )}

                  {displaySites.length === 0 ? (
                    <div className="py-10 text-center" role="status">
                      <MapPin className="mx-auto h-10 w-10 text-gray-400" aria-hidden="true" />
                      <h3 className="mt-3 text-sm font-medium text-gray-900">No active sites</h3>
                      <p className="mt-1 text-sm text-gray-500">
                        This tenant has no active farm sites available for assignment.
                      </p>
                    </div>
                  ) : (
                    <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200">
                      {displaySites.map((site) => {
                        const isAssigned = assignedSiteIds.has(site.id);
                        const accessibleSiteName = site.availableForAssignment
                          ? site.name
                          : `${site.name} ${site.id}`;
                        return (
                          <li
                            key={site.id}
                            className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <MapPin
                                  className="h-4 w-4 flex-none text-gray-400"
                                  aria-hidden="true"
                                />
                                <p className="truncate text-sm font-medium text-gray-900">
                                  {site.name}
                                </p>
                              </div>
                              <p className="mt-1 pl-6 text-xs text-gray-500">
                                {site.availableForAssignment ? 'Site code' : 'Site ID'}: {site.code}
                              </p>
                            </div>
                            <div className="flex items-center justify-between gap-3 sm:justify-end">
                              <span
                                className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
                                  isAssigned
                                    ? 'bg-green-100 text-green-700'
                                    : 'bg-gray-100 text-gray-600'
                                }`}
                              >
                                {isAssigned
                                  ? site.availableForAssignment
                                    ? 'Assigned'
                                    : 'Assigned · unavailable'
                                  : 'Not assigned'}
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  openConfirmation(isAssigned ? 'unassign' : 'assign', site)
                                }
                                disabled={
                                  operationPending || visibleFeedback?.retryAssignments === true
                                }
                                aria-label={`${
                                  isAssigned ? 'Remove' : 'Assign'
                                } ${accessibleSiteName} access for ${user.name}`}
                                className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                                  isAssigned
                                    ? 'border-red-200 text-red-700 hover:bg-red-50'
                                    : 'border-tenant-200 text-tenant-700 hover:bg-tenant-50'
                                }`}
                              >
                                {isAssigned ? 'Remove access' : 'Assign access'}
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
            </div>

            <div className="flex justify-end border-t border-gray-100 px-6 py-4">
              <button
                type="button"
                onClick={handleClose}
                className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
              >
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
