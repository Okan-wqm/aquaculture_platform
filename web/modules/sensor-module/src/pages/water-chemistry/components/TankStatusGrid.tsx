/**
 * Tank status grid (P1) — lightweight, recharts-free small multiples.
 *
 * O(N) plain-DOM status chips driven by the engine status fns (via engine-adapter),
 * NOT N heavy Deffeyes charts. Click a card to drill down into that tank.
 */
import { type ReactElement } from 'react';

import { tankStatus, type StatusLevel } from '../engine-adapter';
import type { ResolvedParameterSet, WcScope } from '../types';
import { useScopeTanks } from '../useResolvedParameterSet';

const LEVEL_CLASS: Record<StatusLevel, string> = {
  safe: 'border-green-300 bg-green-50',
  alert: 'border-yellow-300 bg-yellow-50',
  danger: 'border-red-300 bg-red-50',
  unknown: 'border-gray-200 bg-gray-50',
};
const LEVEL_DOT: Record<StatusLevel, string> = {
  safe: 'bg-green-500',
  alert: 'bg-yellow-500',
  danger: 'bg-red-500',
  unknown: 'bg-gray-400',
};

function TankCard({
  set,
  onSelect,
}: {
  set: ResolvedParameterSet;
  onSelect: (tankId: string) => void;
}): ReactElement {
  const st = tankStatus(set);
  return (
    <button
      type="button"
      onClick={() => onSelect(set.scope.id)}
      className={`flex flex-col gap-1 rounded-lg border p-3 text-left transition hover:shadow ${LEVEL_CLASS[st.level]}`}
    >
      <div className="flex items-center justify-between">
        <span className="truncate text-sm font-medium text-gray-800">{set.scopeName}</span>
        <span className={`h-2.5 w-2.5 rounded-full ${LEVEL_DOT[st.level]}`} />
      </div>
      <div className="flex gap-3 text-xs text-gray-600">
        <span>pH {st.ph == null ? '—' : st.ph.toFixed(2)}</span>
        <span>DO {st.dissolvedOxygen == null ? '—' : `${st.dissolvedOxygen.toFixed(1)}`}</span>
      </div>
      <div className="min-h-[1rem] text-xs text-gray-500">
        {st.reasons.length ? st.reasons.join(' · ') : st.level === 'safe' ? 'all clear' : ''}
      </div>
    </button>
  );
}

const TankStatusGrid = ({
  scope,
  onSelectTank,
}: {
  scope: WcScope;
  onSelectTank: (tankId: string) => void;
}): ReactElement => {
  const { data, isLoading, isError } = useScopeTanks(scope);
  if (isLoading) return <p className="text-sm text-gray-400">Resolving tanks…</p>;
  if (isError) return <p className="text-sm text-red-500">Failed to resolve tanks.</p>;
  if (!data || data.length === 0) return <p className="text-sm text-gray-400">No tanks in this scope.</p>;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {data.map((set) => (
        <TankCard key={set.scope.id} set={set} onSelect={onSelectTank} />
      ))}
    </div>
  );
};

export default TankStatusGrid;
