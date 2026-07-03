/**
 * Water Chemistry Monitoring — card canvas (P2, mock, frontend-only).
 *
 * A drag/resize GridStack canvas of configurable cards. Each card = an explicitly-
 * configured measurement point (scope + sampling point + species/limits + per-parameter
 * sensor/manual source + volume) rendering a switchable chart (Deffeyes/NH₃/H₂S/CO₂).
 * "+" adds a card and opens its config drawer; cards persist in localStorage.
 */
import { type FC, useState } from 'react';

import WcCanvas from './canvas/WcCanvas';
import WcCardConfigDrawer from './canvas/WcCardConfigDrawer';
import { TANKS } from './mock/fixtures';
import { isSystemCard } from './types';
import { useWcCards } from './useWcCards';

const WaterChemistryMonitoringPage: FC = () => {
  const { cards, addCard, addSystemCard, updateCard, removeCard, resetDemo } = useWcCards();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = cards.find((c) => c.id === selectedId) ?? null;
  // The Configure drawer edits a POINT card; system-card configuration (member opt-out +
  // target/toxic/reagents sections) is a follow-up, so only point cards open the drawer.
  const selectedPoint = selected && !isSystemCard(selected) ? selected : null;

  const handleAdd = (): void => {
    const id = addCard({ kind: 'tank', id: TANKS[0]?.id ?? 't1' });
    setSelectedId(id);
  };
  const handleAddSystem = (): void => {
    addSystemCard('loop-a');
  };

  return (
    <div className="p-4">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Water Chemistry Monitoring</h1>
          <p className="text-sm text-gray-500">
            Configurable per-point chart cards.{' '}
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700">P2 · mock data</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={handleAdd}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700">
            ＋ Add chart
          </button>
          <button type="button" onClick={handleAddSystem}
            className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">
            ＋ Add system
          </button>
          <button type="button" onClick={resetDemo}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50">
            Reset demo
          </button>
        </div>
      </div>

      {cards.length === 0 ? (
        <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-gray-300 bg-gray-50 text-sm text-gray-500">
          No charts yet — click “＋ Add chart”.
        </div>
      ) : (
        <WcCanvas
          cards={cards}
          onChange={updateCard}
          onConfigure={setSelectedId}
          onRemove={removeCard}
        />
      )}

      {selectedPoint && (
        <WcCardConfigDrawer
          card={selectedPoint}
          onChange={(patch) => updateCard(selectedPoint.id, patch)}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
};

export default WaterChemistryMonitoringPage;
