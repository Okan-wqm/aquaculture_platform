/**
 * OverlayStack — Portal-based renderer for all active overlays.
 *
 * Renders PopupCard or ModalDialog components into document.body
 * based on each overlay entry's `type` field.
 */
import React from 'react';
import ReactDOM from 'react-dom';
import { useScadaPackageStore } from '../../store/scada';
import { PopupCard } from './PopupCard';
import { ModalDialog } from './ModalDialog';

export const OverlayStack: React.FC = () => {
  const overlays = useScadaPackageStore((s) => s.overlays);

  if (overlays.length === 0) return null;

  return ReactDOM.createPortal(
    <>
      {overlays.map((o) =>
        o.type === 'card' ? (
          <PopupCard key={o.id} overlay={o} />
        ) : (
          <ModalDialog key={o.id} overlay={o} />
        ),
      )}
    </>,
    document.body,
  );
};
