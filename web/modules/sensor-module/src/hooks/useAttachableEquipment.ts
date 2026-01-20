/**
 * Hook for fetching attachable equipment (isVisibleInSensor: true)
 * Enhances equipment with linking status for Process Editor
 */

import { useMemo } from 'react';
import { useEquipmentList, Equipment, groupEquipmentByCategory, CATEGORY_LABELS } from './useEquipment';
import { useProcessStore } from '../store/processStore';

/**
 * Extended equipment interface with linking status
 */
export interface AttachableEquipment extends Equipment {
  isLinked: boolean;
  linkedNodeId?: string;
}

/**
 * Hook to fetch equipment that can be attached to process nodes
 * Only fetches equipment with isVisibleInSensor: true
 */
export function useAttachableEquipment(searchTerm?: string) {
  const equipmentNodeMap = useProcessStore((state) => state.equipmentNodeMap);

  // Fetch equipment with isVisibleInSensor filter
  const { data, isLoading, error, refetch } = useEquipmentList({
    isVisibleInSensor: true,
    isActive: true,
  });

  // Enhance equipment with linking status
  const enhancedEquipment = useMemo(() => {
    if (!data?.items) return [];

    return data.items.map((eq): AttachableEquipment => ({
      ...eq,
      isLinked: !!equipmentNodeMap[eq.id],
      linkedNodeId: equipmentNodeMap[eq.id],
    }));
  }, [data?.items, equipmentNodeMap]);

  // Filter by search term
  const filtered = useMemo(() => {
    if (!searchTerm) return enhancedEquipment;
    const term = searchTerm.toLowerCase();
    return enhancedEquipment.filter(
      (eq) =>
        eq.name.toLowerCase().includes(term) ||
        eq.code.toLowerCase().includes(term) ||
        eq.equipmentType?.name.toLowerCase().includes(term)
    );
  }, [enhancedEquipment, searchTerm]);

  // Group by category
  const groupedByCategory = useMemo(() => {
    return groupEquipmentByCategory(filtered) as Record<string, AttachableEquipment[]>;
  }, [filtered]);

  // Statistics
  const linkedCount = useMemo(() => {
    return enhancedEquipment.filter((eq) => eq.isLinked).length;
  }, [enhancedEquipment]);

  const unlinkedCount = useMemo(() => {
    return enhancedEquipment.filter((eq) => !eq.isLinked).length;
  }, [enhancedEquipment]);

  return {
    equipment: filtered,
    groupedEquipment: groupedByCategory,
    isLoading,
    error,
    refetch,
    totalCount: data?.total || 0,
    linkedCount,
    unlinkedCount,
  };
}

// Re-export category labels for use in components
export { CATEGORY_LABELS };
