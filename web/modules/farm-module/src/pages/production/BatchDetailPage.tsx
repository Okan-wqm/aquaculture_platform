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

const BatchOverviewTab = React.lazy(
  () => import('./tabs/BatchOverviewTab'),
);
const BatchTanksTab = React.lazy(
  () => import('./tabs/BatchTanksTab'),
);
const BatchFeedingTab = React.lazy(
  () => import('./tabs/BatchFeedingTab'),
);
const BatchTraceabilityTab = React.lazy(
  () => import('./tabs/BatchTraceabilityTab'),
);

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
        <div className="animate-pulse text-gray-500">
          Parti detayı yükleniyor…
        </div>
      </div>
    );
  }

  if (error || !batch) {
    return (
      <div className="p-6">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <h2 className="text-lg font-semibold text-red-800">
            Parti bulunamadı
          </h2>
          <p className="mt-1 text-sm text-red-700">
            Parti ID <code>{batchId}</code> sistemde mevcut değil veya
            erişiminiz yok.
          </p>
          <button
            type="button"
            onClick={() => navigate('/sites/tanks')}
            className="mt-3 px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700"
          >
            Listeye dön
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Page header — batch number + status pill + back link */}
      <div className="flex items-start justify-between">
        <div>
          <button
            type="button"
            onClick={() => navigate('/sites/tanks')}
            className="text-sm text-blue-600 hover:underline"
          >
            ← Parti Listesi
          </button>
          <h1 className="mt-1 text-2xl font-bold text-gray-900">
            {batch.batchNumber}
            {batch.name && (
              <span className="ml-2 text-lg font-normal text-gray-500">
                — {batch.name}
              </span>
            )}
          </h1>
        </div>
        <BatchStatusPill status={batch.status} />
      </div>

      {/* Tab navigation */}
      <nav
        className="flex space-x-1 border-b border-gray-200"
        aria-label="Batch detail tabs"
      >
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              `px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                isActive
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
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
          <div className="animate-pulse text-gray-500">
            Sekme yükleniyor…
          </div>
        }
      >
        <Routes>
          <Route
            index
            element={<Navigate to="overview" replace />}
          />
          <Route
            path="overview"
            element={<BatchOverviewTab batch={batch} />}
          />
          <Route
            path="tanks"
            element={<BatchTanksTab batch={batch} />}
          />
          <Route
            path="feeding"
            element={<BatchFeedingTab batch={batch} />}
          />
          <Route
            path="traceability"
            element={<BatchTraceabilityTab batch={batch} />}
          />
          <Route
            path="*"
            element={<Navigate to="overview" replace />}
          />
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
  QUARANTINE: 'bg-yellow-100 text-yellow-800',
  ACTIVE: 'bg-green-100 text-green-800',
  GROWING: 'bg-blue-100 text-blue-800',
  PRE_HARVEST: 'bg-purple-100 text-purple-800',
  HARVESTING: 'bg-purple-200 text-purple-900',
  HARVESTED: 'bg-gray-200 text-gray-700',
  CLOSED: 'bg-gray-300 text-gray-800',
  CANCELLED: 'bg-red-100 text-red-800',
};

const BatchStatusPill: React.FC<{ status: string }> = ({ status }) => {
  const colour = STATUS_COLOURS[status] ?? 'bg-gray-100 text-gray-700';
  return (
    <span
      className={`px-3 py-1 text-xs font-semibold rounded-full ${colour}`}
    >
      {status}
    </span>
  );
};

export default BatchDetailPage;
