/**
 * Tank Allocation Section Component
 * Handles distributing batch quantity to tanks
 */
import React, { useMemo } from 'react';
import type { AvailableTank, InitialLocationInput } from '../../../hooks/useBatches';
import { Spinner, Button, Input } from '@aquaculture/shared-ui';
import { CircleAlert, Plus, Trash2, TriangleAlert } from 'lucide-react';

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
  tanksError?: Error | null;
  totalQuantity: number;
  avgWeightG: number;
}

export const TankAllocationSection: React.FC<TankAllocationSectionProps> = ({
  allocations,
  onAllocationsChange,
  availableTanks,
  isLoadingTanks,
  tanksError,
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
    const selectedTankIds = allocations.map((a) => a.tankId).filter((id) => id !== currentTankId);
    return availableTanks.filter((t) => !selectedTankIds.includes(t.id));
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
    onAllocationsChange(allocations.filter((a) => a.id !== id));
  };

  const handleAllocationChange = (
    id: string,
    field: keyof TankAllocation,
    value: string | number,
  ) => {
    onAllocationsChange(
      allocations.map((a) =>
        a.id === id ? { ...a, [field]: field === 'quantity' ? Number(value) || 0 : value } : a,
      ),
    );
  };

  // Calculate biomass for a given quantity
  const calculateBiomass = (quantity: number): number => {
    if (!avgWeightG || avgWeightG <= 0) return 0;
    return (quantity * avgWeightG) / 1000; // kg
  };

  // Check if tank has enough capacity
  const checkTankCapacity = (
    tankId: string,
    quantity: number,
  ): { hasCapacity: boolean; message?: string } => {
    const tank = availableTanks.find((t) => t.id === tankId);
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
        <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Tank Allocations <span className="text-red-500">*</span>
        </h4>
        <div className="text-sm">
          <span
            className={
              remainingQuantity === 0
                ? 'text-green-600'
                : isOverAllocated
                  ? 'text-red-600'
                  : 'text-amber-600'
            }
          >
            {allocatedQuantity.toLocaleString()}
          </span>
          <span className="text-gray-500 dark:text-gray-400">
            {' '}
            / {totalQuantity.toLocaleString()} allocated
          </span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="relative">
        <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all ${
              isOverAllocated ? 'bg-red-500' : isFullyAllocated ? 'bg-green-500' : 'bg-amber-500'
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
        {isFullyAllocated && <p className="text-xs text-green-600 mt-1">All units allocated</p>}
      </div>

      {/* Allocation List */}
      {allocations.length > 0 && (
        <div className="space-y-3">
          {allocations.map((allocation) => {
            const availableForRow = getAvailableTanksForRow(allocation.tankId);
            const selectedTank = availableTanks.find((t) => t.id === allocation.tankId);
            const capacityCheck = allocation.tankId
              ? checkTankCapacity(allocation.tankId, allocation.quantity)
              : { hasCapacity: true };

            return (
              <div
                key={allocation.id}
                className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 space-y-3"
              >
                <div className="grid grid-cols-12 gap-3">
                  {/* Tank Selection */}
                  <div className="col-span-5">
                    <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                      Tank <span className="text-red-500">*</span>
                    </label>
                    <select
                      value={allocation.tankId}
                      onChange={(e) =>
                        handleAllocationChange(allocation.id, 'tankId', e.target.value)
                      }
                      className={`w-full px-3 py-2 text-sm border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                        !allocation.tankId
                          ? 'border-amber-300'
                          : 'border-gray-300 dark:border-gray-600'
                      }`}
                      disabled={isLoadingTanks}
                    >
                      <option value="">Select a tank...</option>
                      {/* Show currently selected tank */}
                      {selectedTank && !availableForRow.find((t) => t.id === selectedTank.id) && (
                        <option key={selectedTank.id} value={selectedTank.id}>
                          {selectedTank.code} - {selectedTank.name} (
                          {selectedTank.availableCapacity.toFixed(1)} kg available)
                        </option>
                      )}
                      {availableForRow.map((tank) => (
                        <option key={tank.id} value={tank.id}>
                          {tank.code} - {tank.name} ({tank.availableCapacity.toFixed(1)} kg
                          available)
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Quantity */}
                  <div className="col-span-3">
                    <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                      Quantity <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="number"
                      min="1"
                      value={allocation.quantity || ''}
                      onChange={(e) =>
                        handleAllocationChange(allocation.id, 'quantity', e.target.value)
                      }
                      className={`w-full px-3 py-2 text-sm border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                        !capacityCheck.hasCapacity
                          ? 'border-amber-400'
                          : 'border-gray-300 dark:border-gray-600'
                      }`}
                      placeholder="0"
                    />
                    {!capacityCheck.hasCapacity && (
                      <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                        <TriangleAlert className="w-3 h-3" aria-hidden="true" />
                        {capacityCheck.message} (Warning - will still be added)
                      </p>
                    )}
                  </div>

                  {/* Biomass (calculated) */}
                  <div className="col-span-2">
                    <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                      Biomass (kg)
                    </label>
                    <Input
                      fullWidth
                      type="text"
                      readOnly
                      value={calculateBiomass(allocation.quantity).toFixed(2)}
                    />
                  </div>

                  {/* Remove Button */}
                  <div className="col-span-2 flex items-end justify-end">
                    <Button
                      variant="ghost"
                      type="button"
                      onClick={() => handleRemoveAllocation(allocation.id)}
                      title="Remove allocation"
                    >
                      <Trash2 className="w-5 h-5" aria-hidden="true" />
                    </Button>
                  </div>
                </div>

                {/* Tank Info */}
                {selectedTank && (
                  <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 pt-2 border-t border-gray-200 dark:border-gray-700">
                    <span>
                      Department: {selectedTank.departmentName}
                      {selectedTank.siteName && ` | Site: ${selectedTank.siteName}`}
                    </span>
                    <span>
                      Current: {selectedTank.currentBiomass.toFixed(1)} kg | Max:{' '}
                      {selectedTank.maxBiomass.toFixed(1)} kg | Density:{' '}
                      {selectedTank.currentDensity.toFixed(2)} kg/m³
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
        <Button variant="secondary" type="button" onClick={handleAddAllocation}>
          <span className="flex items-center justify-center">
            <Plus className="w-5 h-5 mr-2" aria-hidden="true" />
            Add Tank Allocation
          </span>
        </Button>
      )}

      {/* No Tanks Available Message */}
      {isLoadingTanks ? (
        <div className="text-center py-4 text-gray-500 dark:text-gray-400">
          <Spinner size="md" color="inherit" block className="mb-2" />
          Loading available tanks...
        </div>
      ) : tanksError ? (
        <div className="text-center py-4 text-red-600 bg-red-50 rounded-lg">
          <CircleAlert className="w-8 h-8 mx-auto mb-2" aria-hidden="true" />
          <p className="font-medium">Failed to load tanks</p>
          <p className="text-sm text-red-500 mt-1">
            {tanksError instanceof Error ? tanksError.message : 'An unexpected error occurred'}
          </p>
        </div>
      ) : availableTanks.length === 0 ? (
        <div className="text-center py-4 text-amber-600 bg-amber-50 rounded-lg">
          <TriangleAlert className="w-8 h-8 mx-auto mb-2" aria-hidden="true" />
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
  biomassKg: number,
): InitialLocationInput {
  return {
    locationType: 'tank',
    tankId: allocation.tankId,
    quantity: allocation.quantity,
    biomass: biomassKg,
    allocationDate: allocation.allocationDate,
  };
}
