/**
 * Cleaner Fish Management Page
 *
 * Manages cleaner fish (Lumpfish, Wrasse) batches and their deployment to tanks.
 * Supports multiple species per tank with individual tracking.
 */
import React, { useState, useMemo } from 'react';
import { Button } from '@aquaculture/shared-ui';
import {
  useCleanerFishBatches,
  useCleanerFishSpecies,
  CleanerFishBatch,
  CleanerFishSpecies,
} from '../../hooks/useCleanerFish';
import { useTanksList } from '../../hooks/useTanks';

// Components
import { CleanerBatchList } from './components/CleanerBatchList';
import { TankCleanerFishCard } from './components/TankCleanerFishCard';
import { CreateBatchModal } from './components/CreateBatchModal';
import { DeployModal } from './components/DeployModal';
import { TransferModal } from './components/TransferModal';
import { MortalityModal } from './components/MortalityModal';
import { RemoveModal } from './components/RemoveModal';

import { CleanerFishTab } from './types';

// Icons
const FishIcon = () => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M18 12c0 4-4 6-8 6s-8-2-8-6 4-6 8-6 8 2 8 6z"
    />
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M18 12l4-2v4l-4-2zM6 12a2 2 0 100-4 2 2 0 000 4z"
    />
  </svg>
);

const TankIcon = () => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z"
    />
  </svg>
);

const PlusIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
  </svg>
);

interface TabConfig {
  id: CleanerFishTab;
  label: string;
  icon: React.ReactNode;
  description: string;
}

const tabs: TabConfig[] = [
  {
    id: 'batches',
    label: 'Batches',
    icon: <FishIcon />,
    description: 'Manage cleaner fish batches',
  },
  {
    id: 'tank-overview',
    label: 'Tank Overview',
    icon: <TankIcon />,
    description: 'View cleaner fish per tank',
  },
];

export const CleanerFishPage: React.FC = () => {
  // State
  const [activeTab, setActiveTab] = useState<CleanerFishTab>('batches');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showDeployModal, setShowDeployModal] = useState(false);
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [showMortalityModal, setShowMortalityModal] = useState(false);
  const [showRemoveModal, setShowRemoveModal] = useState(false);

  // Selected items for modals
  const [selectedBatch, setSelectedBatch] = useState<CleanerFishBatch | null>(null);
  const [selectedTankId, setSelectedTankId] = useState<string | null>(null);

  // Data hooks
  const { data: batches, isLoading: batchesLoading, refetch: refetchBatches } = useCleanerFishBatches();
  const { data: species, isLoading: speciesLoading } = useCleanerFishSpecies();
  const { data: tanksData, isLoading: tanksLoading } = useTanksList();
  const tanks = tanksData?.items || [];

  // Create species lookup map
  const speciesMap = useMemo(() => {
    if (!species) return new Map<string, CleanerFishSpecies>();
    return new Map(species.map((s) => [s.id, s]));
  }, [species]);

  // Enrich batches with species info
  const enrichedBatches = useMemo(() => {
    if (!batches) return [];
    return batches.map((batch) => ({
      ...batch,
      speciesName: speciesMap.get(batch.speciesId)?.commonName || 'Unknown',
      speciesCode: speciesMap.get(batch.speciesId)?.code || '',
    }));
  }, [batches, speciesMap]);

  // Get active batches (with available quantity)
  const activeBatches = useMemo(() => {
    return enrichedBatches.filter((b) => b.currentQuantity > 0 && b.status === 'ACTIVE');
  }, [enrichedBatches]);

  // Handlers
  const handleCreateSuccess = () => {
    setShowCreateModal(false);
    refetchBatches();
  };

  const handleDeployClick = (batch: CleanerFishBatch) => {
    setSelectedBatch(batch);
    setShowDeployModal(true);
  };

  const handleTransferClick = (tankId: string, batchId: string) => {
    const batch = batches?.find((b) => b.id === batchId) || null;
    setSelectedBatch(batch);
    setSelectedTankId(tankId);
    setShowTransferModal(true);
  };

  const handleMortalityClick = (tankId: string, batchId: string) => {
    const batch = batches?.find((b) => b.id === batchId) || null;
    setSelectedBatch(batch);
    setSelectedTankId(tankId);
    setShowMortalityModal(true);
  };

  const handleRemoveClick = (tankId: string, batchId: string) => {
    const batch = batches?.find((b) => b.id === batchId) || null;
    setSelectedBatch(batch);
    setSelectedTankId(tankId);
    setShowRemoveModal(true);
  };

  const handleOperationSuccess = () => {
    refetchBatches();
    setSelectedBatch(null);
    setSelectedTankId(null);
  };

  const isLoading = batchesLoading || speciesLoading || tanksLoading;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Page Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="px-4 sm:px-6 py-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Cleaner Fish Management</h1>
              <p className="mt-1 text-sm text-gray-500">
                Manage cleaner fish species (Lumpfish, Wrasse) and their tank deployments
              </p>
            </div>
            <div className="flex items-center space-x-3">
              <Button
                variant="primary"
                onClick={() => setShowCreateModal(true)}
                className="inline-flex items-center"
              >
                <PlusIcon />
                <span className="ml-2">Create Batch</span>
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="bg-white border-b border-gray-200">
        <div className="px-4 sm:px-6">
          <nav className="-mb-px flex space-x-8" aria-label="Tabs">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`
                  group inline-flex items-center py-4 px-1 border-b-2 font-medium text-sm whitespace-nowrap
                  ${
                    activeTab === tab.id
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }
                `}
              >
                <span
                  className={`mr-2 ${
                    activeTab === tab.id
                      ? 'text-blue-500'
                      : 'text-gray-400 group-hover:text-gray-500'
                  }`}
                >
                  {tab.icon}
                </span>
                {tab.label}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* Tab Content */}
      <div className="px-4 sm:px-6 py-6">
        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
          </div>
        ) : activeTab === 'batches' ? (
          <CleanerBatchList
            batches={enrichedBatches}
            species={species || []}
            onDeploy={handleDeployClick}
            onRefresh={refetchBatches}
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {tanks.map((tank) => (
              <TankCleanerFishCard
                key={tank.id}
                tankId={tank.id}
                tankName={tank.name}
                tankCode={tank.code}
                onTransfer={handleTransferClick}
                onMortality={handleMortalityClick}
                onRemove={handleRemoveClick}
              />
            ))}
            {tanks.length === 0 && (
              <div className="col-span-full text-center py-12 text-gray-500">
                No tanks available. Create tanks in the Setup section.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Modals */}
      <CreateBatchModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        species={species || []}
        onSuccess={handleCreateSuccess}
      />

      <DeployModal
        isOpen={showDeployModal}
        onClose={() => {
          setShowDeployModal(false);
          setSelectedBatch(null);
        }}
        batch={selectedBatch}
        batches={activeBatches}
        tanks={tanks}
        onSuccess={handleOperationSuccess}
      />

      <TransferModal
        isOpen={showTransferModal}
        onClose={() => {
          setShowTransferModal(false);
          setSelectedBatch(null);
          setSelectedTankId(null);
        }}
        batch={selectedBatch}
        sourceTankId={selectedTankId}
        tanks={tanks}
        onSuccess={handleOperationSuccess}
      />

      <MortalityModal
        isOpen={showMortalityModal}
        onClose={() => {
          setShowMortalityModal(false);
          setSelectedBatch(null);
          setSelectedTankId(null);
        }}
        batch={selectedBatch}
        tankId={selectedTankId}
        onSuccess={handleOperationSuccess}
      />

      <RemoveModal
        isOpen={showRemoveModal}
        onClose={() => {
          setShowRemoveModal(false);
          setSelectedBatch(null);
          setSelectedTankId(null);
        }}
        batch={selectedBatch}
        tankId={selectedTankId}
        onSuccess={handleOperationSuccess}
      />
    </div>
  );
};

export default CleanerFishPage;
