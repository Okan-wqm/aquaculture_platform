/**
 * Connection Point Context Menu
 * Right-click menu for changing connection point type (input/output)
 */

import React, { useEffect, useRef } from 'react';
import { ConnectionPointPosition, ConnectionPointType } from '../../equipment-icons/equipmentTypes';
import { ToggleButton } from '@aquaculture/shared-ui';

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
      className="fixed z-50 bg-white dark:bg-gray-900 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 min-w-[160px]"
      style={{
        left: position.x,
        top: position.y,
      }}
    >
      {/* Header */}
      <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-700">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
          {positionLabels[connectionPointId]} Bağlantı Noktası
        </span>
      </div>

      {/* Menu Items */}
      <div className="py-1">
        <ToggleButton
          onClick={handleSetInput}
          pressed={currentType === 'input'}
          className="w-full px-3 py-2 text-left text-sm flex items-center gap-2 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          pressedClassName="bg-info-50 dark:bg-info-900/20 text-info-700 dark:text-info-300"
          idleClassName="text-gray-700 dark:text-gray-300"
        >
          <span
            className={`
              w-3 h-3 rounded-full border-2
              ${currentType === 'input' ? 'bg-info-500 border-info-500' : 'border-info-400'}
            `}
          />
          <span>Giriş Olarak Ayarla</span>
          {currentType === 'input' && <span className="ml-auto text-info-500">✓</span>}
        </ToggleButton>

        <ToggleButton
          onClick={handleSetOutput}
          pressed={currentType === 'output'}
          className="w-full px-3 py-2 text-left text-sm flex items-center gap-2 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          pressedClassName="bg-success-50 dark:bg-success-900/20 text-success-700 dark:text-success-300"
          idleClassName="text-gray-700 dark:text-gray-300"
        >
          <span
            className={`
              w-3 h-3 rounded-full border-2
              ${currentType === 'output' ? 'bg-success-500 border-success-500' : 'border-success-400'}
            `}
          />
          <span>Çıkış Olarak Ayarla</span>
          {currentType === 'output' && <span className="ml-auto text-success-500">✓</span>}
        </ToggleButton>
      </div>
    </div>
  );
};

export default ConnectionPointContextMenu;
