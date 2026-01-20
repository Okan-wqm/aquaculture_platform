/**
 * Tank Allocation Section Component
 * Handles distributing batch quantity to tanks
 */
import React, { useMemo } from 'react';
import type { AvailableTank, InitialLocationInput } from '../../../hooks/useBatches';

interface TankAllocation {
  id: string;
  tankId: string;
  quantity: number;
  allocationDate?: string;
}

interface TankAllocationSectionProps {
  allocations: TankAllocation[];
  onAllocationsChange: (allocations: TankAllocation[]) => void;
  availableTanks: AvailableTank[];
  isLoadingTanks: boolean;
  totalQuantity: number;
  avgWeightG: number;
}

export const TankAllocationSection: React.FC<TankAllocationSectionProps> = ({
  allocations,
  onAllocationsChange,
  availableTanks,
  isLoadingTanks,
  totalQuantity,
  avgWeightG,
}) => {
  // Calculate allocated quantity
  const allocatedQuantity = useMemo(() => {
    return allocations.reduce((sum, a) => sum + (a.quantity || 0), 0);
  }, [allocations]);

  const remainingQuantity = totalQuantity - allocatedQuantity;
  const allocationPercentage = totalQuantity > 0 ? (allocatedQuantity / totalQuantity) * 100 : 0;
  const isFullyAllocated = remainingQuantity === 0 && totalQuantity > 0;
  const isOverAllocated = remainingQuantity < 0;

  // Get tanks that are not already selected
  const getAvailableTanksForRow = (currentTankId?: string) => {
    const selectedTankIds = allocations
      .map(a => a.tankId)
      .filter(id => id !== currentTankId);
    return availableTanks.filter(t => !selectedTankIds.includes(t.id));
  };

  const handleAddAllocation = () => {
    const newId = `alloc-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    onAllocationsChange([
      ...allocations,
      {
        id: newId,
        tankId: '',
        quantity: remainingQuantity > 0 ? remainingQuantity : 0,
        allocationDate: new Date().toISOString().split('T')[0],
      },
    ]);
  };

  const handleRemoveAllocation = (id: string) => {
    onAllocationsChange(allocations.filter(a => a.id !== id));
  };

  const handleAllocationChange = (id: string, field: keyof TankAllocation, value: string | number) => {
    onAllocationsChange(
      allocations.map(a =>
        a.id === id
          ? { ...a, [field]: field === 'quantity' ? Number(value) || 0 : value }
          : a
      )
    );
  };

  // Calculate biomass for a given quantity
  const calculateBiomass = (quantity: number): number => {
    if (!avgWeightG || avgWeightG <= 0) return 0;
    return (quantity * avgWeightG) / 1000; // kg
  };

  // Check if tank has enough capacity
  const checkTankCapacity = (tankId: string, quantity: number): { hasCapacity: boolean; message?: string } => {
    const tank = availableTanks.find(t => t.id === tankId);
    if (!tank) return { hasCapacity: true };

    const biomassToAdd = calculateBiomass(quantity);
    if (biomassToAdd > tank.availableCapacity) {
      return {
        hasCapacity: false,
        message: `Exceeds capacity by ${(biomassToAdd - tank.availableCapacity).toFixed(1)} kg`,
      };
    }
    return { hasCapacity: true };
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-gray-700">
          Tank Allocations <span className="text-red-500">*</span>
        </h4>
        <div className="text-sm">
          <span className={remainingQuantity === 0 ? 'text-green-600' : isOverAllocated ? 'text-red-600' : 'text-amber-600'}>
            {allocatedQuantity.toLocaleString()}
          </span>
          <span className="text-gray-500"> / {totalQuantity.toLocaleString()} allocated</span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="relative">
        <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all ${
              isOverAllocated
                ? 'bg-red-500'
                : isFullyAllocated
                ? 'bg-green-500'
                : 'bg-amber-500'
            }`}
            style={{ width: `${Math.min(allocationPercentage, 100)}%` }}
          />
        </div>
        {!isFullyAllocated && !isOverAllocated && remainingQuantity > 0 && (
          <p className="text-xs text-amber-600 mt-1">
            {remainingQuantity.toLocaleString()} remaining to allocate
          </p>
        )}
        {isOverAllocated && (
          <p className="text-xs text-red-600 mt-1">
            Over-allocated by {Math.abs(remainingQuantity).toLocaleString()} units
          </p>
        )}
        {isFullyAllocated && (
          <p className="text-xs text-green-600 mt-1">
            All units allocated
          </p>
        )}
      </div>

      {/* Allocation List */}
      {allocations.length > 0 && (
        <div className="space-y-3">
          {allocations.map((allocation) => {
            const availableForRow = getAvailableTanksForRow(allocation.tankId);
            const selectedTank = availableTanks.find(t => t.id === allocation.tankId);
            const capacityCheck = allocation.tankId
              ? checkTankCapacity(allocation.tankId, allocation.quantity)
              : { hasCapacity: true };

            return (
              <div
                key={allocation.id}
                className="p-4 border border-gray-200 rounded-lg bg-gray-50 space-y-3"
              >
                <div className="grid grid-cols-12 gap-3">
                  {/* Tank Selection */}
                  <div className="col-span-5">
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Tank <span className="text-red-500">*</span>
                    </label>
                    <select
                      value={allocation.tankId}
                      onChange={(e) => handleAllocationChange(allocation.id, 'tankId', e.target.value)}
                      className={`w-full px-3 py-2 text-sm border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                        !allocation.tankId ? 'border-amber-300' : 'border-gray-300'
                      }`}
                      disabled={isLoadingTanks}
                    >
                      <option value="">Select a tank...</option>
                      {/* Show currently selected tank */}
                      {selectedTank && !availableForRow.find(t => t.id === selectedTank.id) && (
                        <option key={selectedTank.id} value={selectedTank.id}>
                          {selectedTank.code} - {selectedTank.name} ({selectedTank.availableCapacity.toFixed(1)} kg available)
                        </option>
                      )}
                      {availableForRow.map((tank) => (
                        <option key={tank.id} value={tank.id}>
                          {tank.code} - {tank.name} ({tank.availableCapacity.toFixed(1)} kg available)
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Quantity */}
                  <div className="col-span-3">
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Quantity <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="number"
                      min="1"
                      value={allocation.quantity || ''}
                      onChange={(e) => handleAllocationChange(allocation.id, 'quantity', e.target.value)}
                      className={`w-full px-3 py-2 text-sm border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                        !capacityCheck.hasCapacity ? 'border-amber-400' : 'border-gray-300'
                      }`}
                      placeholder="0"
                    />
                    {!capacityCheck.hasCapacity && (
                      <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                        </svg>
                        {capacityCheck.message} (Warning - will still be added)
                      </p>
                    )}
                  </div>

                  {/* Biomass (calculated) */}
                  <div className="col-span-2">
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Biomass (kg)
                    </label>
                    <input
                      type="text"
                      readOnly
                      value={calculateBiomass(allocation.quantity).toFixed(2)}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-gray-100 text-gray-600"
                    />
                  </div>

                  {/* Remove Button */}
                  <div className="col-span-2 flex items-end justify-end">
                    <button
                      type="button"
                      onClick={() => handleRemoveAllocation(allocation.id)}
                      className="p-2 text-gray-400 hover:text-red-600 transition-colors"
                      title="Remove allocation"
                    >
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Tank Info */}
                {selectedTank && (
                  <div className="flex items-center justify-between text-xs text-gray-500 pt-2 border-t border-gray-200">
                    <span>
                      Department: {selectedTank.departmentName}
                      {selectedTank.siteName && ` | Site: ${selectedTank.siteName}`}
                    </span>
                    <span>
                      Current: {selectedTank.currentBiomass.toFixed(1)} kg |
                      Max: {selectedTank.maxBiomass.toFixed(1)} kg |
                      Density: {selectedTank.currentDensity.toFixed(2)} kg/m³
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Add Allocation Button */}
      {availableTanks.length > allocations.length && (
        <button
          type="button"
          onClick={handleAddAllocation}
          className="w-full py-2 px-4 border-2 border-dashed border-gray-300 rounded-lg text-sm text-gray-600 hover:border-gray-400 hover:text-gray-800 transition-colors"
        >
          <span className="flex items-center justify-center">
            <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
            </svg>
            Add Tank Allocation
          </span>
        </button>
      )}

      {/* No Tanks Available Message */}
      {isLoadingTanks ? (
        <div className="text-center py-4 text-gray-500">
          <svg className="animate-spin h-6 w-6 mx-auto mb-2" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
          </svg>
          Loading available tanks...
        </div>
      ) : availableTanks.length === 0 ? (
        <div className="text-center py-4 text-amber-600 bg-amber-50 rounded-lg">
          <svg className="w-8 h-8 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
          </svg>
          No tanks available. Please create tanks in Equipment setup first.
        </div>
      ) : null}

      {/* Validation Messages */}
      {allocations.length === 0 && totalQuantity > 0 && (
        <p className="text-xs text-amber-600">
          Please add at least one tank allocation to distribute the batch quantity.
        </p>
      )}
    </div>
  );
};

export default TankAllocationSection;

// Helper to convert TankAllocation to InitialLocationInput for API
export function toLocationInput(
  allocation: { tankId: string; quantity: number; allocationDate?: string },
  biomassKg: number
): InitialLocationInput {
  return {
    locationType: 'tank',
    tankId: allocation.tankId,
    quantity: allocation.quantity,
    biomass: biomassKg,
    allocationDate: allocation.allocationDate,
  };
}
