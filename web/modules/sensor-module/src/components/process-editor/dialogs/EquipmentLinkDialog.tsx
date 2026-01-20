/**
 * Equipment Link Dialog
 * Modal dialog for confirming equipment-to-node linking with name customization
 */

import React, { useState, useEffect } from 'react';
import { X, Link2, CheckCircle } from 'lucide-react';
import { AttachableEquipment } from '../../../hooks/useAttachableEquipment';
import { getEquipmentIcon } from '../../equipment-icons';

interface EquipmentLinkDialogProps {
  isOpen: boolean;
  equipment: AttachableEquipment | null;
  onClose: () => void;
  onConfirm: (customName: string) => void;
}

export const EquipmentLinkDialog: React.FC<EquipmentLinkDialogProps> = ({
  isOpen,
  equipment,
  onClose,
  onConfirm,
}) => {
  const [customName, setCustomName] = useState('');

  // Update name when equipment changes
  useEffect(() => {
    if (equipment) {
      setCustomName(equipment.name);
    }
  }, [equipment]);

  // Handle ESC key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !equipment) return null;

  const Icon = getEquipmentIcon(equipment.equipmentType?.code || 'default');

  const handleConfirm = () => {
    if (customName.trim()) {
      onConfirm(customName.trim());
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && customName.trim()) {
      handleConfirm();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <Link2 className="w-5 h-5 text-cyan-600" />
            Link Equipment
          </h3>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
            title="Close"
          >
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {/* Equipment Preview */}
          <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg border border-gray-100">
            <div className="p-2 bg-white rounded-lg shadow-sm">
              <Icon size={32} className="text-gray-700" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-gray-900 truncate">{equipment.name}</p>
              <p className="text-sm text-gray-500 truncate">{equipment.code}</p>
              {equipment.equipmentType && (
                <p className="text-xs text-gray-400 truncate capitalize">
                  {equipment.equipmentType.name}
                </p>
              )}
            </div>
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
              equipment.status === 'operational' || equipment.status === 'active'
                ? 'bg-green-100 text-green-700'
                : equipment.status === 'maintenance'
                ? 'bg-yellow-100 text-yellow-700'
                : 'bg-gray-100 text-gray-700'
            }`}>
              {equipment.status}
            </span>
          </div>

          {/* Custom Name Input */}
          <div>
            <label
              htmlFor="equipment-name"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Node Name
            </label>
            <input
              id="equipment-name"
              type="text"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              onKeyDown={handleKeyDown}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500 transition-colors"
              placeholder="Edit equipment name..."
              autoFocus
            />
            <p className="text-xs text-gray-500 mt-1.5">
              This name will be displayed on the canvas. You can edit it later.
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-3 p-4 border-t border-gray-200 bg-gray-50 rounded-b-xl">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2.5 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 font-medium transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!customName.trim()}
            className="flex-1 px-4 py-2.5 text-white bg-cyan-600 rounded-lg hover:bg-cyan-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium transition-colors flex items-center justify-center gap-2"
          >
            <CheckCircle className="w-4 h-4" />
            Link
          </button>
        </div>
      </div>
    </div>
  );
};

export default EquipmentLinkDialog;
