/**
 * Water Chemistry Monitoring (P2/P5, mock, frontend-only).
 *
 * A top TAB strip: the "Cards" tab is a drag/resize GridStack canvas of per-point chart cards;
 * each additional tab is a SYSTEM (loop) rendered as one overlaid Deffeyes view (all its
 * measurement points on one chart). "Add system" auto-includes every member and opens a new tab.
 * Cards + system tabs each persist in localStorage.
 */
import { type FC, useState } from 'react';

import WcCanvas from './canvas/WcCanvas';
import WcCardConfigDrawer from './canvas/WcCardConfigDrawer';
import { TANKS } from './mock/fixtures';
import { useWcCards } from './useWcCards';
import { useWcSystems } from './useWcSystems';
import WcSystemView from './WcSystemView';

const WaterChemistryMonitoringPage: FC = () => {
  const { cards, addCard, updateCard, removeCard, resetDemo } = useWcCards();
  const { systems, addSystem, updateSystem, removeSystem } = useWcSystems();
  const [activeTab, setActiveTab] = useState<string>('cards');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedCard = cards.find((c) => c.id === selectedId) ?? null;

  const activeSystem = systems.find((s) => s.id === activeTab) ?? null;

  const handleAdd = (): void => {
    setActiveTab('cards');
    setSelectedId(addCard({ kind: 'tank', id: TANKS[0]?.id ?? 't1' }));
  };
  const handleAddSystem = (): void => {
    setActiveTab(addSystem('loop-a'));
  };
  const handleRemoveSystem = (id: string): void => {
    removeSystem(id);
    setActiveTab('cards');
  };

  const tabClass = (active: boolean): string =>
    `whitespace-nowrap rounded-t px-3 py-1.5 text-sm ${
      active ? 'border-b-2 border-blue-600 font-medium text-blue-700' : 'text-gray-500 hover:text-gray-800'
    }`;

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Water Chemistry Monitoring</h1>
          <p className="text-sm text-gray-500">
            Per-point cards &amp; per-system overlay.{' '}
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700">mock data</span>
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

      {/* Tab strip: Cards + one per system */}
      <div className="mb-4 flex items-center gap-1 overflow-x-auto border-b border-gray-200">
        <button type="button" className={tabClass(activeTab === 'cards')} onClick={() => setActiveTab('cards')}>
          Cards
        </button>
        {systems.map((s) => (
          <button key={s.id} type="button" className={tabClass(activeTab === s.id)} onClick={() => setActiveTab(s.id)}>
            {s.title}
          </button>
        ))}
      </div>

      {activeTab === 'cards' ? (
        cards.length === 0 ? (
          <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-gray-300 bg-gray-50 text-sm text-gray-500">
            No charts yet — click “＋ Add chart”.
          </div>
        ) : (
          <WcCanvas cards={cards} onChange={updateCard} onConfigure={setSelectedId} onRemove={removeCard} />
        )
      ) : activeSystem ? (
        <WcSystemView
          system={activeSystem}
          onChange={(patch) => updateSystem(activeSystem.id, patch)}
          onRemove={() => handleRemoveSystem(activeSystem.id)}
        />
      ) : null}

      {activeTab === 'cards' && selectedCard && (
        <WcCardConfigDrawer
          card={selectedCard}
          onChange={(patch) => updateCard(selectedCard.id, patch)}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
};

export default WaterChemistryMonitoringPage;
