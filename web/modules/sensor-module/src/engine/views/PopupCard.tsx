/**
 * PopupCard — Floating card overlay rendered at a specified position.
 *
 * Rendered by OverlayStack when an overlay entry has `type: 'card'`.
 * The card is clamped to the viewport so it never renders off-screen.
 */
import React, { useCallback, useEffect, useMemo } from 'react';
import { X } from 'lucide-react';
import { useScadaStore } from '../../store/scada';
import type { OverlayEntry } from './types';

interface PopupCardProps {
  overlay: OverlayEntry;
}

export const PopupCard: React.FC<PopupCardProps> = ({ overlay }) => {
  const screens = useScadaStore((s) => s.screens);
  const closeOverlay = useScadaStore((s) => s.closeOverlay);

  const screen = useMemo(
    () => screens.find((s) => s.id === overlay.screenId),
    [screens, overlay.screenId],
  );

  const width = overlay.size?.width ?? 400;
  const height = overlay.size?.height ?? 300;

  // Clamp position to viewport
  const clampedX = Math.min(
    Math.max(overlay.position?.x ?? 100, 0),
    window.innerWidth - width,
  );
  const clampedY = Math.min(
    Math.max(overlay.position?.y ?? 100, 0),
    window.innerHeight - height,
  );

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
    <div
      style={{
        position: 'fixed',
        left: clampedX,
        top: clampedY,
        width,
        height,
        background: '#fff',
        borderRadius: 12,
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 10000,
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
          padding: '10px 14px',
          borderBottom: '1px solid #e5e7eb',
          background: '#f9fafb',
          borderRadius: '12px 12px 0 0',
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
  );
};
