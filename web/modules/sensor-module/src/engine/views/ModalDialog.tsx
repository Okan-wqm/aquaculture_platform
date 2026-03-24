/**
 * ModalDialog — Centered modal overlay with dark backdrop.
 *
 * Rendered by OverlayStack when an overlay entry has `type: 'dialog'`.
 * Clicking the backdrop or pressing Escape closes the dialog.
 */
import React, { useCallback, useEffect, useMemo } from 'react';
import { X } from 'lucide-react';
import { useScadaStore } from '../../store/scada';
import type { OverlayEntry } from './types';

interface ModalDialogProps {
  overlay: OverlayEntry;
}

export const ModalDialog: React.FC<ModalDialogProps> = ({ overlay }) => {
  const screens = useScadaStore((s) => s.screens);
  const closeOverlay = useScadaStore((s) => s.closeOverlay);

  const screen = useMemo(
    () => screens.find((s) => s.id === overlay.screenId),
    [screens, overlay.screenId],
  );

  const width = overlay.size?.width ?? 600;
  const height = overlay.size?.height ?? 450;

  const handleClose = useCallback(() => {
    closeOverlay(overlay.id);
  }, [closeOverlay, overlay.id]);

  // Close on Escape key
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleClose]);

  const screenName = screen?.name ?? 'Unknown';
  const widgetCount = screen?.widgets.length ?? 0;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={handleClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.4)',
          backdropFilter: 'blur(2px)',
          zIndex: 10000,
        }}
      />

      {/* Dialog */}
      <div
        style={{
          position: 'fixed',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          width,
          height,
          background: '#fff',
          borderRadius: 16,
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          display: 'flex',
          flexDirection: 'column',
          zIndex: 10001,
          animation: 'scada-fade-in 0.15s ease-out',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            borderBottom: '1px solid #e5e7eb',
            background: '#f9fafb',
            borderRadius: '16px 16px 0 0',
            flexShrink: 0,
          }}
        >
          <span style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>
            {screenName}
          </span>
          <button
            onClick={handleClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 4,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 6,
              color: '#6b7280',
            }}
            aria-label="Close overlay"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div
          style={{
            flex: 1,
            padding: 16,
            overflow: 'auto',
            fontSize: 13,
            color: '#374151',
          }}
        >
          Screen: {screenName} ({widgetCount} widgets)
        </div>
      </div>
    </>
  );
};
