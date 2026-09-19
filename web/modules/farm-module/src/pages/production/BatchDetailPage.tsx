/**
 * BatchDetailPage
 *
 * Single-batch detail surface — three tabs (Overview / Tanks /
 * Feeding) that each render the batch under different lenses and
 * surface the action buttons for the Tier 1 + Tier 2 + Tier 3
 * mutations.
 *
 * Closes:
 *   - FE-HIGH-002: BatchInputTab.tsx:218 was navigating to
 *     `/sites/batch/${batch.id}` but no Route existed for that
 *     path. The link landed on the catch-all `Navigate to
 *     "/sites/map"`, silently swallowing the user's click.
 *   - FE-MEDIUM-001: CloseBatchModal / UpdateBatchStatusModal /
 *     AllocateBatchToTankModal / AssignFeedsToBatchModal were
 *     already implemented but never imported by any page —
 *     this PR wires them all into the tabs below.
 *
 * Scope C PR-0b. See `docs/plans/2026-04-24-*` for the full plan
 * (FE-HIGH-002 + FE-MEDIUM-001 close on this PR).
 */
import React, { Suspense } from 'react';
import { useParams, useNavigate, NavLink, Routes, Route, Navigate } from 'react-router-dom';

import { useBatch } from '../../hooks/useBatches';
import { PageHeader, Button } from '@aquaculture/shared-ui';

const BatchOverviewTab = React.lazy(() => import('./tabs/BatchOverviewTab'));
const BatchTanksTab = React.lazy(() => import('./tabs/BatchTanksTab'));
const BatchFeedingTab = React.lazy(() => import('./tabs/BatchFeedingTab'));
const BatchTraceabilityTab = React.lazy(() => import('./tabs/BatchTraceabilityTab'));

/**
 * Tab descriptor. The `to` field is RELATIVE to the page's base
 * path — react-router resolves it against the current `BatchDetailPage`
 * mount point.
 */
const TABS = [
  { to: 'overview', label: 'Genel Bakış' },
  { to: 'tanks', label: 'Tanklar' },
  { to: 'feeding', label: 'Yem Atamaları' },
  { to: 'traceability', label: 'Traceability' },
] as const;

const BatchDetailPage: React.FC = () => {
  const { batchId } = useParams<{ batchId: string }>();
  const navigate = useNavigate();

  const { data: batch, isLoading, error } = useBatch(batchId ?? '');

  if (!batchId) {
    // URL malformed (no batchId param) — bounce back to the list.
    return <Navigate to="/sites/tanks" replace />;
  }

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="animate-pulse text-gray-500 dark:text-gray-400">
          Parti detayı yükleniyor…
        </div>
      </div>
    );
  }

  if (error || !batch) {
    return (
      <div className="p-6">
        <div className="bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg p-4">
          <h2 className="text-lg font-semibold text-error-800 dark:text-error-200">
            Parti bulunamadı
          </h2>
          <p className="mt-1 text-sm text-error-700 dark:text-error-300">
            Parti ID <code>{batchId}</code> sistemde mevcut değil veya erişiminiz yok.
          </p>
          <Button
            variant="danger"
            size="sm"
            className="mt-3"
            type="button"
            onClick={() => navigate('/sites/tanks')}
          >
            Listeye dön
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Page header — batch number + status pill + back link */}
      <PageHeader
        title={
          <>
            {batch.batchNumber}
            {batch.name && (
              <span className="ml-2 text-lg font-normal text-gray-500 dark:text-gray-400">
                — {batch.name}
              </span>
            )}
          </>
        }
        eyebrow={
          <Button variant="ghost" type="button" onClick={() => navigate('/sites/tanks')}>
            ← Parti Listesi
          </Button>
        }
        actions={<BatchStatusPill status={batch.status} />}
      />

      {/* Tab navigation */}
      <nav
        className="flex space-x-1 border-b border-gray-200 dark:border-gray-700"
        aria-label="Batch detail tabs"
      >
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              `px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                isActive
                  ? 'border-info-600 text-info-600 dark:text-info-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100 hover:border-gray-300 dark:hover:border-gray-500'
              }`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      {/* Tab content — lazy so a heavy tab doesn't slow the initial paint */}
      <Suspense
        fallback={
          <div className="animate-pulse text-gray-500 dark:text-gray-400">Sekme yükleniyor…</div>
        }
      >
        <Routes>
          <Route index element={<Navigate to="overview" replace />} />
          <Route path="overview" element={<BatchOverviewTab batch={batch} />} />
          <Route path="tanks" element={<BatchTanksTab batch={batch} />} />
          <Route path="feeding" element={<BatchFeedingTab batch={batch} />} />
          <Route path="traceability" element={<BatchTraceabilityTab batch={batch} />} />
          <Route path="*" element={<Navigate to="overview" replace />} />
        </Routes>
      </Suspense>
    </div>
  );
};

/**
 * Status pill — colour-codes the BatchStatus enum so operators can
 * see at a glance whether the batch is `ACTIVE`, `HARVESTING`, etc.
 */
const STATUS_COLOURS: Record<string, string> = {
  QUARANTINE: 'bg-warning-100 dark:bg-warning-900/40 text-warning-800 dark:text-warning-200',
  ACTIVE: 'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200',
  GROWING: 'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200',
  PRE_HARVEST: 'bg-accent-100 dark:bg-accent-900/40 text-accent-800 dark:text-accent-200',
  HARVESTING: 'bg-accent-200 dark:bg-accent-800/50 text-accent-900 dark:text-accent-100',
  HARVESTED: 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300',
  CLOSED: 'bg-gray-300 text-gray-800 dark:text-gray-200',
  CANCELLED: 'bg-error-100 dark:bg-error-900/40 text-error-800 dark:text-error-200',
};

const BatchStatusPill: React.FC<{ status: string }> = ({ status }) => {
  const colour =
    STATUS_COLOURS[status] ?? 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300';
  return <span className={`px-3 py-1 text-xs font-semibold rounded-full ${colour}`}>{status}</span>;
};

export default BatchDetailPage;
