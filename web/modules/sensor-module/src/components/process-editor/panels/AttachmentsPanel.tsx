/**
 * Attachments Panel Component
 * Right sidebar panel for viewing attachable equipment (isVisibleInSensor: true)
 * Shows equipment grouped by category with linking status
 */

import React, { useState } from 'react';
import { Search, ChevronDown, ChevronRight, Link2, Check, Package, RefreshCw } from 'lucide-react';
import { useAttachableEquipment, AttachableEquipment, CATEGORY_LABELS } from '../../../hooks/useAttachableEquipment';
import { useProcessStore } from '../../../store/processStore';
import { getEquipmentIcon } from '../../equipment-icons';
import { Spinner, Button } from '@aquaculture/shared-ui';

interface AttachmentsPanelProps {
  className?: string;
}


export const AttachmentsPanel: React.FC<AttachmentsPanelProps> = ({ className = '' }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());

  const { groupedEquipment, isLoading, error, refetch, linkedCount, unlinkedCount } =
    useAttachableEquipment(searchTerm);

  const { selectedNode, selectNode, nodes, highlightNode } = useProcessStore();

  // Toggle category expansion
  const toggleCategory = (category: string) => {
    setExpandedCategories((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(category)) {
        newSet.delete(category);
      } else {
        newSet.add(category);
      }
      return newSet;
    });
  };

  // Expand all categories
  const expandAll = () => {
    setExpandedCategories(new Set(Object.keys(groupedEquipment)));
  };

  // Collapse all categories
  const collapseAll = () => {
    setExpandedCategories(new Set());
  };

  // Handle equipment click
  const handleEquipmentClick = (equipment: AttachableEquipment) => {
    if (equipment.isLinked && equipment.linkedNodeId) {
      // Find and select the linked node
      const linkedNode = nodes.find((n) => n.id === equipment.linkedNodeId);
      if (linkedNode) {
        selectNode(linkedNode);
        // Highlight the node on the canvas with flash animation
        highlightNode(linkedNode.id);
      }
    }
    // If not linked, we don't do anything here - linking is done via Properties panel
  };

  // Get category label
  const getCategoryLabel = (category: string): string => {
    return CATEGORY_LABELS[category] || category;
  };

  // Loading state
  if (isLoading) {
    return (
      <div className={`flex flex-col items-center justify-center h-full ${className}`}>
        <Spinner size="lg" className="mb-3" />
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading equipment...</p>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className={`flex flex-col items-center justify-center h-full p-4 ${className}`}>
        <Package className="w-12 h-12 text-red-300 mb-3" />
        <p className="text-sm text-red-600 text-center mb-3">Error loading equipment</p>
        <Button variant="ghost" size="sm" leftIcon={<RefreshCw className="w-4 h-4" />} onClick={() => refetch()}>Retry</Button>
      </div>
    );
  }

  const categoryEntries = Object.entries(groupedEquipment);

  return (
    <div className={`flex flex-col h-full bg-white dark:bg-gray-900 ${className}`}>
      {/* Header */}
      <div className="p-4 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-gray-900 dark:text-gray-100">Equipment</h3>
          <div className="flex items-center gap-2">
            <span className="text-xs text-cyan-600 bg-cyan-50 px-2 py-1 rounded-full">
              {linkedCount} linked
            </span>
            <span className="text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded-full">
              {unlinkedCount} available
            </span>
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 dark:text-gray-400" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search equipment..."
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500 transition-colors"
          />
        </div>

        {/* Expand/Collapse buttons */}
        {categoryEntries.length > 0 && (
          <div className="flex gap-2 mt-2">
            <Button variant="ghost" size="xs" onClick={expandAll}>Expand All</Button>
            <span className="text-gray-500 dark:text-gray-400">|</span>
            <Button variant="ghost" size="xs" onClick={collapseAll}>Collapse All</Button>
          </div>
        )}
      </div>

      {/* Equipment List */}
      <div className="flex-1 overflow-y-auto p-2">
        {categoryEntries.length === 0 ? (
          <div className="text-center py-8 text-gray-500 dark:text-gray-400">
            <Package className="w-12 h-12 mx-auto mb-2 text-gray-500 dark:text-gray-400" />
            <p className="text-sm">
              {searchTerm ? 'No matching equipment found' : 'No visible equipment found'}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Enable "Show in Sensor Module" in equipment settings
            </p>
          </div>
        ) : (
          categoryEntries.map(([category, equipmentList]) => {
            const isExpanded = expandedCategories.has(category);
            const linkedInCategory = equipmentList.filter((eq) => eq.isLinked).length;

            return (
              <div key={category} className="mb-1">
                {/* Category Header */}
                <Button variant="ghost" onClick={() => toggleCategory(category)}>{isExpanded ? (
                    <ChevronDown className="w-4 h-4 text-gray-500 dark:text-gray-400" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-gray-500 dark:text-gray-400" />
                  )}
                  <span className="flex-1 text-left">{getCategoryLabel(category)}</span>
                  {linkedInCategory > 0 && (
                    <span className="text-xs text-cyan-600 bg-cyan-50 px-1.5 py-0.5 rounded">
                      {linkedInCategory}
                    </span>
                  )}
                  <span className="text-xs text-gray-500 dark:text-gray-400">{equipmentList.length}</span></Button>

                {/* Equipment Items */}
                {isExpanded && (
                  <div className="ml-2 space-y-0.5 pb-1">
                    {equipmentList.map((equipment) => {
                      const Icon = getEquipmentIcon(equipment.equipmentType?.code || 'default');

                      return (
                        <button
                          key={equipment.id}
                          onClick={() => handleEquipmentClick(equipment)}
                          disabled={!equipment.isLinked}
                          className={`w-full flex items-center gap-2 px-2 py-2 text-sm rounded-lg transition-colors ${
                            equipment.isLinked
                              ? 'bg-cyan-50 border border-cyan-200 hover:bg-cyan-100 cursor-pointer'
                              : 'hover:bg-gray-50 dark:hover:bg-gray-800 border border-transparent cursor-default opacity-75'
                          }`}
                          title={
                            equipment.isLinked
                              ? 'Click to select linked node'
                              : 'Select a node and link equipment via Properties panel'
                          }
                        >
                          <Icon size={20} className="text-gray-600 dark:text-gray-400 flex-shrink-0" />
                          <div className="flex-1 min-w-0 text-left">
                            <p className="font-medium text-gray-900 dark:text-gray-100 truncate">{equipment.name}</p>
                            <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{equipment.code}</p>
                          </div>
                          {equipment.isLinked ? (
                            <Check className="w-4 h-4 text-cyan-600 flex-shrink-0" />
                          ) : (
                            <Link2 className="w-4 h-4 text-gray-500 dark:text-gray-400 flex-shrink-0" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
        <p className="text-xs text-gray-500 dark:text-gray-400 text-center">
          {linkedCount > 0
            ? 'Click on linked equipment to highlight on canvas'
            : 'Select a node and link equipment via Properties panel'}
        </p>
      </div>
    </div>
  );
};

export default AttachmentsPanel;
