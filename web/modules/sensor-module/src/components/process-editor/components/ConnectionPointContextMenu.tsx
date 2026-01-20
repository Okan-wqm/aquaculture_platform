/**
 * Connection Point Context Menu
 * Right-click menu for changing connection point type (input/output)
 */

import React, { useEffect, useRef } from 'react';
import { ConnectionPointPosition, ConnectionPointType } from '../../equipment-icons/equipmentTypes';

interface ConnectionPointContextMenuProps {
  isOpen: boolean;
  position: { x: number; y: number };
  connectionPointId: ConnectionPointPosition;
  currentType: ConnectionPointType;
  onChangeType: (pointId: ConnectionPointPosition, newType: ConnectionPointType) => void;
  onClose: () => void;
}

export const ConnectionPointContextMenu: React.FC<ConnectionPointContextMenuProps> = ({
  isOpen,
  position,
  connectionPointId,
  currentType,
  onChangeType,
  onClose,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen, onClose]);

  // Close on escape key
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSetInput = () => {
    onChangeType(connectionPointId, 'input');
    onClose();
  };

  const handleSetOutput = () => {
    onChangeType(connectionPointId, 'output');
    onClose();
  };

  const positionLabels: Record<ConnectionPointPosition, string> = {
    top: 'Üst',
    right: 'Sağ',
    bottom: 'Alt',
    left: 'Sol',
  };

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-white rounded-lg shadow-lg border border-gray-200 py-1 min-w-[160px]"
      style={{
        left: position.x,
        top: position.y,
      }}
    >
      {/* Header */}
      <div className="px-3 py-2 border-b border-gray-100">
        <span className="text-xs font-medium text-gray-500">
          {positionLabels[connectionPointId]} Bağlantı Noktası
        </span>
      </div>

      {/* Menu Items */}
      <div className="py-1">
        <button
          onClick={handleSetInput}
          className={`
            w-full px-3 py-2 text-left text-sm flex items-center gap-2
            hover:bg-gray-50 transition-colors
            ${currentType === 'input' ? 'bg-blue-50 text-blue-700' : 'text-gray-700'}
          `}
        >
          <span
            className={`
              w-3 h-3 rounded-full border-2
              ${currentType === 'input' ? 'bg-blue-500 border-blue-500' : 'border-blue-400'}
            `}
          />
          <span>Giriş Olarak Ayarla</span>
          {currentType === 'input' && (
            <span className="ml-auto text-blue-500">✓</span>
          )}
        </button>

        <button
          onClick={handleSetOutput}
          className={`
            w-full px-3 py-2 text-left text-sm flex items-center gap-2
            hover:bg-gray-50 transition-colors
            ${currentType === 'output' ? 'bg-green-50 text-green-700' : 'text-gray-700'}
          `}
        >
          <span
            className={`
              w-3 h-3 rounded-full border-2
              ${currentType === 'output' ? 'bg-green-500 border-green-500' : 'border-green-400'}
            `}
          />
          <span>Çıkış Olarak Ayarla</span>
          {currentType === 'output' && (
            <span className="ml-auto text-green-500">✓</span>
          )}
        </button>
      </div>
    </div>
  );
};

export default ConnectionPointContextMenu;
