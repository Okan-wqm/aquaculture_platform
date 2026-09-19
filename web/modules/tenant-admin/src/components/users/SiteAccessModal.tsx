import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Button } from '@aquaculture/shared-ui';
import { AlertCircle, CheckCircle2, MapPin, RefreshCw, ShieldCheck } from 'lucide-react';
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

  const handleClose = (): void => {
    if (operationPending) return;
    setPendingAction(null);
    setConfirmationError(null);
    setFeedback(null);
    setSessionBoundaryMessage(null);
    onClose();
  };

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
    <Modal
      isOpen={dialogIsOpen}
      onClose={handleClose}
      size="lg"
      className="max-h-[85vh] overflow-hidden flex flex-col"
      bodyClassName="flex-1 min-h-0 flex flex-col"
      showCloseButton={!operationPending}
      closeOnEscape={!operationPending}
      closeOnOverlayClick={!operationPending}
      title={`Site access for ${user.name}`}
      description="Choose which active farm sites this user can access."
    >
      {synchronousBoundaryMessage ? (
        <div className="space-y-4 px-6 py-8">
          <div
            className="rounded-xl border border-warning-200 dark:border-warning-800 bg-warning-50 dark:bg-warning-900/20 p-4"
            role="alert"
          >
            <div className="flex items-start gap-3">
              <AlertCircle
                className="mt-0.5 h-5 w-5 flex-none text-warning-600 dark:text-warning-400"
                aria-hidden="true"
              />
              <div>
                <p className="text-sm font-medium text-warning-900 dark:text-warning-100">
                  Tenant session changed
                </p>
                <p className="mt-1 text-sm text-warning-800 dark:text-warning-200">
                  {synchronousBoundaryMessage}
                </p>
              </div>
            </div>
          </div>
          <div className="flex justify-end">
            <Button variant="primary" type="button" onClick={handleClose}>
              Close
            </Button>
          </div>
        </div>
      ) : visiblePendingAction ? (
        <div className="px-6 py-8" aria-live="polite">
          <div className="mx-auto max-w-lg text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-success-100 dark:bg-success-900/40">
              <ShieldCheck
                className="h-6 w-6 text-success-700 dark:text-success-300"
                aria-hidden="true"
              />
            </div>
            <h3 className="mt-4 text-lg font-semibold text-gray-900 dark:text-gray-100">
              {confirmationIsAssignment ? 'Assign site access?' : 'Remove site access?'}
            </h3>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              {confirmationIsAssignment
                ? `${user.name} will be able to view data for ${visiblePendingAction.site.name}.`
                : `${user.name} will no longer be able to view data for ${visiblePendingAction.site.name}.`}
            </p>
          </div>

          {confirmationError && (
            <div
              className="mt-5 rounded-lg border border-error-200 dark:border-error-800 bg-error-50 dark:bg-error-900/20 p-3 text-sm text-error-700 dark:text-error-300"
              role="alert"
            >
              {confirmationError}
            </div>
          )}

          <div className="mt-6 flex justify-end gap-3">
            <Button
              variant="secondary"
              type="button"
              onClick={cancelConfirmation}
              disabled={operationPending}
              autoFocus
            >
              Cancel
            </Button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={operationPending}
              className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                confirmationIsAssignment
                  ? 'bg-success-600 hover:bg-success-700'
                  : 'bg-error-600 hover:bg-error-700'
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
              <div
                className="rounded-xl border border-error-200 dark:border-error-800 bg-error-50 dark:bg-error-900/20 p-4"
                role="alert"
              >
                <p className="text-sm font-medium text-error-800 dark:text-error-200">
                  Tenant session unavailable
                </p>
                <p className="mt-1 text-sm text-error-700 dark:text-error-300">
                  Re-open this user after selecting a tenant.
                </p>
              </div>
            ) : isInitialLoading ? (
              <div
                className="flex items-center justify-center gap-3 py-12 text-sm text-gray-600 dark:text-gray-400"
                role="status"
                aria-live="polite"
              >
                <RefreshCw
                  className="h-5 w-5 animate-spin text-success-600 dark:text-success-400"
                  aria-hidden="true"
                />
                Loading site access...
              </div>
            ) : blockingQueryError ? (
              <div
                className="rounded-xl border border-error-200 dark:border-error-800 bg-error-50 dark:bg-error-900/20 p-4"
                role="alert"
              >
                <div className="flex items-start gap-3">
                  <AlertCircle
                    className="mt-0.5 h-5 w-5 flex-none text-error-600 dark:text-error-400"
                    aria-hidden="true"
                  />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-error-800 dark:text-error-200">
                      Site access could not be loaded
                    </p>
                    <p className="mt-1 text-sm text-error-700 dark:text-error-300">
                      {queryError ? sanitizeErrorMessage(queryError) : 'Please retry the request.'}
                    </p>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="mt-3"
                      type="button"
                      onClick={handleRetryAll}
                      disabled={sitesQuery.isFetching || assignmentsQuery.isFetching}
                    >
                      {(sitesQuery.isFetching || assignmentsQuery.isFetching) && (
                        <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                      )}
                      Retry
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {visibleFeedback && (
                  <div
                    className={`rounded-lg border p-3 ${
                      visibleFeedback.kind === 'success'
                        ? 'border-success-200 dark:border-success-800 bg-success-50 dark:bg-success-900/20 text-success-800 dark:text-success-200'
                        : 'border-warning-200 dark:border-warning-800 bg-warning-50 dark:bg-warning-900/20 text-warning-800 dark:text-warning-200'
                    }`}
                    role={visibleFeedback.kind === 'error' ? 'alert' : 'status'}
                    aria-live="polite"
                  >
                    <div className="flex items-start gap-3">
                      {visibleFeedback.kind === 'success' ? (
                        <CheckCircle2
                          className="mt-0.5 h-5 w-5 flex-none text-success-600 dark:text-success-400"
                          aria-hidden="true"
                        />
                      ) : (
                        <AlertCircle
                          className="mt-0.5 h-5 w-5 flex-none text-warning-600 dark:text-warning-400"
                          aria-hidden="true"
                        />
                      )}
                      <div className="flex-1">
                        <p className="text-sm">{visibleFeedback.message}</p>
                        {visibleFeedback.retryAssignments && (
                          <Button
                            variant="secondary"
                            size="sm"
                            className="mt-2"
                            type="button"
                            onClick={handleRetryAssignments}
                            disabled={assignmentsQuery.isFetching}
                          >
                            {assignmentsQuery.isFetching && (
                              <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                            )}
                            Retry access reload
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {unavailableAssignmentCount > 0 && (
                  <div
                    className="rounded-lg border border-warning-200 dark:border-warning-800 bg-warning-50 dark:bg-warning-900/20 p-3 text-sm text-warning-800 dark:text-warning-200"
                    role="status"
                  >
                    {unavailableAssignmentCount} existing site assignment
                    {unavailableAssignmentCount === 1 ? ' is' : 's are'} no longer in the active
                    farm catalog. It remains visible here only so you can remove it.
                  </div>
                )}

                {displaySites.length === 0 ? (
                  <div className="py-10 text-center" role="status">
                    <MapPin
                      className="mx-auto h-10 w-10 text-gray-400 dark:text-gray-500"
                      aria-hidden="true"
                    />
                    <h3 className="mt-3 text-sm font-medium text-gray-900 dark:text-gray-100">
                      No active sites
                    </h3>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                      This tenant has no active farm sites available for assignment.
                    </p>
                  </div>
                ) : (
                  <ul className="divide-y divide-gray-100 dark:divide-gray-700 rounded-xl border border-gray-200 dark:border-gray-700">
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
                                className="h-4 w-4 flex-none text-gray-400 dark:text-gray-500"
                                aria-hidden="true"
                              />
                              <p className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                                {site.name}
                              </p>
                            </div>
                            <p className="mt-1 pl-6 text-xs text-gray-500 dark:text-gray-400">
                              {site.availableForAssignment ? 'Site code' : 'Site ID'}: {site.code}
                            </p>
                          </div>
                          <div className="flex items-center justify-between gap-3 sm:justify-end">
                            <span
                              className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
                                isAssigned
                                  ? 'bg-success-100 dark:bg-success-900/40 text-success-700 dark:text-success-300'
                                  : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
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
                                  ? 'border-error-200 dark:border-error-800 text-error-700 dark:text-error-300 hover:bg-error-50 dark:hover:bg-error-900/30'
                                  : 'border-success-200 dark:border-success-800 text-success-700 dark:text-success-300 hover:bg-success-50 dark:hover:bg-success-900/30'
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

          <div className="flex justify-end border-t border-gray-100 dark:border-gray-700 px-6 py-4">
            <Button variant="secondary" type="button" onClick={handleClose}>
              Done
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
};
