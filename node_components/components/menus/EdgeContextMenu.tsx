/**
 * EdgeContextMenu Component
 * Context menu for edge operations: change type, change connection style, delete
 */

import React, { useEffect, useRef, useCallback } from 'react';
import { CONNECTION_TYPES, ConnectionTypeConfig } from '../../config/connectionTypes';

type EdgeType = 'multiHandle' | 'draggable' | 'orthogonal';

interface EdgeContextMenuProps {
  isOpen: boolean;
  position: { x: number; y: number };
  edgeId: string;
  currentType: EdgeType;
  currentConnectionType?: string;
  onChangeEdgeType: (edgeId: string, newType: EdgeType) => void;
  onChangeConnectionType: (edgeId: string, connectionType: string) => void;
  onDeleteEdge: (edgeId: string) => void;
  onClose: () => void;
}

export const EdgeContextMenu: React.FC<EdgeContextMenuProps> = ({
  isOpen,
  position,
  edgeId,
  currentType,
  currentConnectionType = 'process-pipe',
  onChangeEdgeType,
  onChangeConnectionType,
  onDeleteEdge,
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

  const handleEdgeTypeChange = useCallback((type: EdgeType) => {
    onChangeEdgeType(edgeId, type);
    onClose();
  }, [edgeId, onChangeEdgeType, onClose]);

  const handleConnectionTypeChange = useCallback((connType: string) => {
    onChangeConnectionType(edgeId, connType);
    onClose();
  }, [edgeId, onChangeConnectionType, onClose]);

  const handleDelete = useCallback(() => {
    onDeleteEdge(edgeId);
    onClose();
  }, [edgeId, onDeleteEdge, onClose]);

  if (!isOpen) return null;

  const edgeTypeOptions: { type: EdgeType; label: string; description: string; icon: React.ReactNode }[] = [
    {
      type: 'multiHandle',
      label: 'Polyline',
      description: 'Coklu noktali duz cizgi',
      icon: (
        <svg width="20" height="16" viewBox="0 0 20 16" fill="none">
          <path d="M2 14L8 6L12 10L18 2" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" />
          <circle cx="8" cy="6" r="2" fill="#3b82f6" />
          <circle cx="12" cy="10" r="2" fill="#3b82f6" />
        </svg>
      ),
    },
    {
      type: 'orthogonal',
      label: 'Orthogonal (90°)',
      description: 'Dik acili koseli cizgi',
      icon: (
        <svg width="20" height="16" viewBox="0 0 20 16" fill="none">
          <path d="M2 14V8H10V2H18" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" />
        </svg>
      ),
    },
    {
      type: 'draggable',
      label: 'Bezier Egrisi',
      description: 'Yumusak kavisli cizgi',
      icon: (
        <svg width="20" height="16" viewBox="0 0 20 16" fill="none">
          <path d="M2 14C6 14 14 2 18 2" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" />
          <circle cx="10" cy="8" r="2" fill="#3b82f6" />
        </svg>
      ),
    },
  ];

  const connectionTypes = Object.values(CONNECTION_TYPES);

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
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.15)',
        padding: 0,
        zIndex: 9999,
        minWidth: 240,
        maxHeight: '70vh',
        overflowY: 'auto',
      }}
    >
      {/* Edge Type Section */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #e5e7eb' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 8 }}>
          CIZGI TIPI
        </div>
        {edgeTypeOptions.map((opt) => (
          <button
            key={opt.type}
            onClick={() => handleEdgeTypeChange(opt.type)}
            style={{
              width: '100%',
              padding: '8px 10px',
              backgroundColor: currentType === opt.type ? '#eff6ff' : 'transparent',
              border: currentType === opt.type ? '1px solid #3b82f6' : '1px solid transparent',
              borderRadius: 6,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              marginBottom: 4,
              transition: 'all 0.15s',
            }}
            onMouseEnter={(e) => {
              if (currentType !== opt.type) e.currentTarget.style.backgroundColor = '#f9fafb';
            }}
            onMouseLeave={(e) => {
              if (currentType !== opt.type) e.currentTarget.style.backgroundColor = 'transparent';
            }}
          >
            <div style={{ flexShrink: 0 }}>{opt.icon}</div>
            <div style={{ textAlign: 'left', flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: '#111827' }}>{opt.label}</div>
              <div style={{ fontSize: 10, color: '#6b7280' }}>{opt.description}</div>
            </div>
            {currentType === opt.type && (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M2 7l4 4 6-8" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" />
              </svg>
            )}
          </button>
        ))}
      </div>

      {/* Connection Type Section (P&ID Standard) */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #e5e7eb' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 8 }}>
          BAGLANTI TIPI (P&ID)
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
          {connectionTypes.map((connType: ConnectionTypeConfig) => (
            <button
              key={connType.code}
              onClick={() => handleConnectionTypeChange(connType.code)}
              style={{
                padding: '6px 8px',
                backgroundColor: currentConnectionType === connType.code ? '#eff6ff' : 'transparent',
                border: currentConnectionType === connType.code ? '1px solid #3b82f6' : '1px solid #e5e7eb',
                borderRadius: 4,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11,
                color: '#374151',
                transition: 'all 0.15s',
              }}
              title={connType.description}
              onMouseEnter={(e) => {
                if (currentConnectionType !== connType.code) e.currentTarget.style.backgroundColor = '#f9fafb';
              }}
              onMouseLeave={(e) => {
                if (currentConnectionType !== connType.code) e.currentTarget.style.backgroundColor = 'transparent';
              }}
            >
              <div
                style={{
                  width: 20,
                  height: 3,
                  backgroundColor: connType.color,
                  borderStyle: connType.dashArray ? 'dashed' : 'solid',
                  borderWidth: 0,
                }}
              />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {connType.nameTr}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Delete Section */}
      <div style={{ padding: '8px 12px' }}>
        <button
          onClick={handleDelete}
          style={{
            width: '100%',
            padding: '8px 12px',
            backgroundColor: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: 6,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            fontSize: 12,
            fontWeight: 500,
            color: '#dc2626',
            transition: 'all 0.15s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = '#fee2e2';
            e.currentTarget.style.borderColor = '#fca5a5';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = '#fef2f2';
            e.currentTarget.style.borderColor = '#fecaca';
          }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M2 4h10M5 4V2h4v2M3 4v8h8V4M6 6v4M8 6v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          Baglantıyı Sil
        </button>
      </div>
    </div>
  );
};

export default EdgeContextMenu;
