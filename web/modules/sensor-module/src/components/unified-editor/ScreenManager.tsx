/**
 * ScreenManager - Screen switching orchestrator for the Unified SCADA Editor
 *
 * Wraps ScreenTabBar and handles:
 * - Viewport save/restore on screen switch
 * - Default screen creation for new projects
 * - PostMessage communication with the canvas iframe for node visibility
 */

import React, { useCallback, useEffect, useRef } from 'react';
import ScreenTabBar from '../scada-builder/ScreenTabBar';
import { useScadaPackageStore, ScreenViewport } from '../../store/scada';

interface ScreenManagerProps {
  /** Ref to the canvas iframe for sending postMessage */
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  /** Whether the canvas is ready to receive messages */
  isCanvasReady: boolean;
}

const ScreenManager: React.FC<ScreenManagerProps> = ({ iframeRef, isCanvasReady }) => {
  const screens = useScadaPackageStore((s) => s.screens);
  const activeScreenId = useScadaPackageStore((s) => s.activeScreenId);
  const addScreen = useScadaPackageStore((s) => s.addScreen);
  const setActiveScreen = useScadaPackageStore((s) => s.setActiveScreen);
  const saveScreenViewport = useScadaPackageStore((s) => s.saveScreenViewport);
  const getScreenViewport = useScadaPackageStore((s) => s.getScreenViewport);

  const prevScreenIdRef = useRef<string>(activeScreenId);

  // Send message to canvas iframe
  const sendToCanvas = useCallback(
    (type: string, data?: unknown) => {
      if (iframeRef.current?.contentWindow) {
        iframeRef.current.contentWindow.postMessage(
          { type, data, source: 'process-editor-host' },
          window.location.origin,
        );
      }
    },
    [iframeRef],
  );

  // Create default screens when project has none
  useEffect(() => {
    if (screens.length === 0) {
      addScreen('process', 'Process');
      addScreen('dashboard', 'Dashboard');
    }
  }, []); // Only on mount

  // Handle screen switching: save old viewport, show new screen's nodes, restore viewport
  useEffect(() => {
    const prevId = prevScreenIdRef.current;
    if (prevId === activeScreenId) return;

    if (!isCanvasReady) {
      prevScreenIdRef.current = activeScreenId;
      return;
    }

    // Save current viewport for the previous screen
    if (prevId) {
      const controller = new AbortController();
      const handler = (event: MessageEvent) => {
        if (event.origin !== window.location.origin) return;
        const msg = event.data || {};
        if (msg.source === 'process-editor-canvas' && msg.type === 'viewportState') {
          const vp = msg.data as ScreenViewport;
          if (vp) saveScreenViewport(prevId, vp);
          controller.abort();
        }
      };
      window.addEventListener('message', handler, { signal: controller.signal });
      sendToCanvas('getViewport');

      // Timeout cleanup
      const timeout = setTimeout(() => controller.abort(), 1000);

      // Component unmount cleanup
      prevScreenIdRef.current = activeScreenId;

      // Tell canvas which screen is now active
      sendToCanvas('setActiveScreen', { screenId: activeScreenId });
      const viewport = getScreenViewport(activeScreenId);
      sendToCanvas('setViewport', viewport);

      return () => {
        controller.abort();
        clearTimeout(timeout);
      };
    }

    // Tell canvas which screen is now active (for node visibility filtering)
    sendToCanvas('setActiveScreen', { screenId: activeScreenId });

    // Restore viewport for the new screen
    const viewport = getScreenViewport(activeScreenId);
    sendToCanvas('setViewport', viewport);

    prevScreenIdRef.current = activeScreenId;
  }, [activeScreenId, isCanvasReady, sendToCanvas, saveScreenViewport, getScreenViewport]);

  return <ScreenTabBar />;
};

export default ScreenManager;
