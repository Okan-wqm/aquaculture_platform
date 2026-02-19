import { useState, useEffect, useRef } from 'react';

// BUG-15: navigator.onLine returns true whenever any network interface is active,
// even WiFi with no internet routing. This is common in field deployments.
// We use a periodic connectivity probe against the health endpoint to determine
// actual server reachability, with navigator.onLine as a fast "definitely offline" signal.

const PROBE_URL = '/graphql';
const PROBE_INTERVAL_MS = 30_000; // 30 seconds
const PROBE_TIMEOUT_MS = 5_000; // 5 seconds per probe

async function probeConnectivity(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const response = await fetch(PROBE_URL, {
      method: 'HEAD',
      signal: controller.signal,
      // No credentials/auth — just checking reachability
      cache: 'no-store',
    });
    clearTimeout(timeout);
    // Any HTTP response (including 4xx) means the server is reachable
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}

export function useNetworkStatus(): boolean {
  // BUG-15: Removed SSR guard (typeof navigator !== 'undefined') — this is a
  // client-only PWA built with Vite, SSR will never occur.
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const probeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleProbe = (delay: number) => {
    if (probeTimerRef.current) clearTimeout(probeTimerRef.current);
    probeTimerRef.current = setTimeout(async () => {
      const reachable = await probeConnectivity();
      setIsOnline(reachable);
      // Reschedule — probe more frequently when offline to detect reconnection sooner
      scheduleProbe(reachable ? PROBE_INTERVAL_MS : 10_000);
    }, delay);
  };

  useEffect(() => {
    const handleOnline = () => {
      // navigator.onLine just became true — probe immediately to confirm
      scheduleProbe(500);
    };

    const handleOffline = () => {
      // navigator.onLine went false — we're definitely offline
      setIsOnline(false);
      scheduleProbe(10_000); // keep probing to detect reconnect
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Initial probe on mount
    scheduleProbe(0);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      if (probeTimerRef.current) clearTimeout(probeTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return isOnline;
}
