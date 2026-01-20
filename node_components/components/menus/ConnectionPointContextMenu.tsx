/**
 * ConnectionPointContextMenu Component
 * Context menu for toggling connection point types (input/output)
 */

import React, { useEffect, useRef, useCallback } from 'react';

type ConnectionPointType = 'input' | 'output';
type ConnectionPointPosition = 'top' | 'right' | 'bottom' | 'left';

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

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen, onClose]);

  // Close on escape
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen, onClose]);

  const handleToggle = useCallback(() => {
    const newType: ConnectionPointType = currentType === 'input' ? 'output' : 'input';
    onChangeType(connectionPointId, newType);
    onClose();
  }, [connectionPointId, currentType, onChangeType, onClose]);

  const handleSetInput = useCallback(() => {
    onChangeType(connectionPointId, 'input');
    onClose();
  }, [connectionPointId, onChangeType, onClose]);

  const handleSetOutput = useCallback(() => {
    onChangeType(connectionPointId, 'output');
    onClose();
  }, [connectionPointId, onChangeType, onClose]);

  if (!isOpen) return null;

  const positionLabels: Record<ConnectionPointPosition, string> = {
    top: 'Ust',
    right: 'Sag',
    bottom: 'Alt',
    left: 'Sol',
  };

  return (
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        left: position.x,
        top: position.y,
        backgroundColor: 'white',
        border: '1px solid #e5e7eb',
        borderRadius: 8,
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
        padding: 8,
        zIndex: 9999,
        minWidth: 180,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '4px 8px',
          borderBottom: '1px solid #e5e7eb',
          marginBottom: 4,
          fontWeight: 600,
          fontSize: 12,
          color: '#374151',
        }}
      >
        {positionLabels[connectionPointId]} Baglanti Noktasi
      </div>

      {/* Current type indicator */}
      <div
        style={{
          padding: '4px 8px',
          fontSize: 11,
          color: '#6b7280',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            backgroundColor: currentType === 'input' ? '#3b82f6' : '#22c55e',
          }}
        />
        Mevcut: {currentType === 'input' ? 'Giris (Mavi)' : 'Cikis (Yesil)'}
      </div>

      {/* Menu items */}
      <div style={{ marginTop: 8 }}>
        <MenuItem
          icon={
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M2 8h12M10 4l4 4-4 4" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" />
            </svg>
          }
          label="Giris (Input)"
          description="Mavi - Veri/akis giris noktasi"
          isSelected={currentType === 'input'}
          onClick={handleSetInput}
        />
        <MenuItem
          icon={
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M14 8H2M6 4l-4 4 4 4" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" />
            </svg>
          }
          label="Cikis (Output)"
          description="Yesil - Veri/akis cikis noktasi"
          isSelected={currentType === 'output'}
          onClick={handleSetOutput}
        />
      </div>

      {/* Quick toggle */}
      <div
        style={{
          marginTop: 8,
          paddingTop: 8,
          borderTop: '1px solid #e5e7eb',
        }}
      >
        <button
          onClick={handleToggle}
          style={{
            width: '100%',
            padding: '8px 12px',
            backgroundColor: '#f3f4f6',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 500,
            color: '#374151',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            transition: 'background-color 0.2s',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#e5e7eb')}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = '#f3f4f6')}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M11 3L3 11M3 3l8 8" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" />
          </svg>
          Degistir ({currentType === 'input' ? 'Cikis' : 'Giris'} Yap)
        </button>
      </div>
    </div>
  );
};

// Menu item component
interface MenuItemProps {
  icon: React.ReactNode;
  label: string;
  description: string;
  isSelected: boolean;
  onClick: () => void;
}

const MenuItem: React.FC<MenuItemProps> = ({ icon, label, description, isSelected, onClick }) => (
  <button
    onClick={onClick}
    style={{
      width: '100%',
      padding: '8px 12px',
      backgroundColor: isSelected ? '#eff6ff' : 'transparent',
      border: isSelected ? '1px solid #3b82f6' : '1px solid transparent',
      borderRadius: 6,
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      marginBottom: 4,
      transition: 'all 0.2s',
    }}
    onMouseEnter={(e) => {
      if (!isSelected) e.currentTarget.style.backgroundColor = '#f9fafb';
    }}
    onMouseLeave={(e) => {
      if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent';
    }}
  >
    <div style={{ flexShrink: 0 }}>{icon}</div>
    <div style={{ textAlign: 'left' }}>
      <div style={{ fontSize: 13, fontWeight: 500, color: '#111827' }}>{label}</div>
      <div style={{ fontSize: 11, color: '#6b7280' }}>{description}</div>
    </div>
    {isSelected && (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ marginLeft: 'auto' }}>
        <path d="M2 7l4 4 6-8" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" />
      </svg>
    )}
  </button>
);

export default ConnectionPointContextMenu;
