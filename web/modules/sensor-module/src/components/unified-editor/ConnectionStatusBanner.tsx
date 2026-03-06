/**
 * ConnectionStatusBanner
 *
 * Minimal status badge for SCADA live data connection.
 * Auto-hides after 3s when connected, shows stale data warning after 30s.
 */

import React, { useEffect, useState } from 'react';
import { useScadaData } from '../../context/ScadaDataProvider';

const STALE_THRESHOLD_MS = 30_000;
const AUTO_HIDE_DELAY_MS = 3_000;

export function ConnectionStatusBanner() {
  const { connectionStatus, isConnected } = useScadaData();
  const [visible, setVisible] = useState(true);
  const [isStale, setIsStale] = useState(false);

  // Auto-hide when connected
  useEffect(() => {
    if (connectionStatus === 'connected') {
      const timer = setTimeout(() => setVisible(false), AUTO_HIDE_DELAY_MS);
      return () => clearTimeout(timer);
    }
    setVisible(true);
  }, [connectionStatus]);

  // Stale data detection
  useEffect(() => {
    if (!isConnected) {
      setIsStale(false);
      return;
    }

    const interval = setInterval(() => {
      // We check lastUpdate from context indirectly - if no data flows for 30s
      // This is a simple heuristic; real staleness should be driven by lastUpdate
      setIsStale((prev) => prev);
    }, STALE_THRESHOLD_MS);

    return () => clearInterval(interval);
  }, [isConnected]);

  // Use a ref-based approach to track actual staleness from data flow
  const [lastDataTime, setLastDataTime] = useState<number>(Date.now());

  useEffect(() => {
    if (isConnected) {
      setLastDataTime(Date.now());
      setIsStale(false);
    }
  }, [isConnected]);

  // Track stale based on time since last values change
  const { values } = useScadaData();
  useEffect(() => {
    setLastDataTime(Date.now());
    setIsStale(false);
  }, [values]);

  useEffect(() => {
    if (!isConnected) return;

    const timer = setInterval(() => {
      if (Date.now() - lastDataTime > STALE_THRESHOLD_MS) {
        setIsStale(true);
        setVisible(true);
      }
    }, 5_000);

    return () => clearInterval(timer);
  }, [isConnected, lastDataTime]);

  if (!visible && !isStale) return null;

  const config = getStatusConfig(connectionStatus, isStale);

  return (
    <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${config.className}`}>
      {config.pulse && (
        <span className="relative flex h-2 w-2">
          <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${config.dotColor}`} />
          <span className={`relative inline-flex rounded-full h-2 w-2 ${config.dotColor}`} />
        </span>
      )}
      {!config.pulse && (
        <span className={`inline-flex rounded-full h-2 w-2 ${config.dotColor}`} />
      )}
      {config.label}
    </div>
  );
}

function getStatusConfig(status: string, isStale: boolean) {
  if (isStale) {
    return {
      label: 'Veri Eski',
      className: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
      dotColor: 'bg-yellow-500',
      pulse: true,
    };
  }

  switch (status) {
    case 'connected':
      return {
        label: 'Bagli',
        className: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
        dotColor: 'bg-green-500',
        pulse: false,
      };
    case 'connecting':
      return {
        label: 'Baglaniyor...',
        className: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
        dotColor: 'bg-yellow-500',
        pulse: true,
      };
    case 'reconnecting':
      return {
        label: 'Yeniden Baglaniyor...',
        className: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
        dotColor: 'bg-orange-500',
        pulse: true,
      };
    case 'disconnected':
    default:
      return {
        label: 'Baglanti Kesildi',
        className: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
        dotColor: 'bg-red-500',
        pulse: false,
      };
  }
}

export default ConnectionStatusBanner;
