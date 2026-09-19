/**
 * Water Chemistry Monitoring (P2/P5, mock, frontend-only).
 *
 * A top TAB strip: the "Cards" tab is a drag/resize GridStack canvas of per-point chart cards;
 * each additional tab is a SYSTEM (loop) rendered as one overlaid Deffeyes view (all its
 * measurement points on one chart). "Add system" auto-includes every member and opens a new tab.
 * Cards + system tabs each persist in localStorage.
 */
import { type FC, useState } from 'react';
import { Button } from '@aquaculture/shared-ui';

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
      active
        ? 'border-b-2 border-info-600 font-medium text-info-700 dark:text-info-300'
        : 'text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100'
    }`;

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            Water Chemistry Monitoring
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Per-point cards &amp; per-system overlay.{' '}
            <span className="rounded bg-warning-100 dark:bg-warning-900/40 px-1.5 py-0.5 text-xs font-medium text-warning-700 dark:text-warning-300">
              mock data
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm" type="button" onClick={handleAdd}>
            ＋ Add chart
          </Button>
          <Button variant="primary" size="sm" type="button" onClick={handleAddSystem}>
            ＋ Add system
          </Button>
          <Button variant="secondary" size="sm" type="button" onClick={resetDemo}>
            Reset demo
          </Button>
        </div>
      </div>

      {/* Tab strip: Cards + one per system */}
      <div className="mb-4 flex items-center gap-1 overflow-x-auto border-b border-gray-200 dark:border-gray-700">
        <button
          type="button"
          className={tabClass(activeTab === 'cards')}
          onClick={() => setActiveTab('cards')}
        >
          Cards
        </button>
        {systems.map((s) => (
          <button
            key={s.id}
            type="button"
            className={tabClass(activeTab === s.id)}
            onClick={() => setActiveTab(s.id)}
          >
            {s.title}
          </button>
        ))}
      </div>

      {activeTab === 'cards' ? (
        cards.length === 0 ? (
          <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 text-sm text-gray-500 dark:text-gray-400">
            No charts yet — click “＋ Add chart”.
          </div>
        ) : (
          <WcCanvas
            cards={cards}
            onChange={updateCard}
            onConfigure={setSelectedId}
            onRemove={removeCard}
          />
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
