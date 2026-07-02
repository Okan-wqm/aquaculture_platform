import { Download, X, Smartphone } from 'lucide-react';
import { useState, useEffect, type ReactElement } from 'react';

import { runAsyncAction } from '@/utils/async-action';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * WHY: `navigator.standalone` is a non-standard, iOS-Safari-only boolean that is
 * absent from the DOM `Navigator` lib type. This narrow shape models exactly
 * that property so the installed-PWA check is fully typed without an unsafe cast.
 */
interface IosNavigator {
  standalone?: boolean;
}

/** Reads the iOS-only standalone flag without widening the global Navigator. */
function isIosStandalone(nav: Navigator): boolean {
  return (nav as Navigator & IosNavigator).standalone === true;
}

const DISMISSED_KEY = 'aquamobil_install_dismissed';

export function InstallPrompt(): ReactElement | null {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showBanner, setShowBanner] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);

  useEffect(() => {
    // Check if already running as installed PWA
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      isIosStandalone(window.navigator);
    setIsStandalone(standalone);

    if (standalone) return;

    // Check if user dismissed recently (24 hours)
    const dismissed = localStorage.getItem(DISMISSED_KEY);
    if (dismissed) {
      const dismissedAt = parseInt(dismissed, 10);
      if (Date.now() - dismissedAt < 24 * 60 * 60 * 1000) return;
    }

    // SEC-08: Detect iOS using userAgent and maxTouchPoints only.
    // navigator.platform is deprecated by all major browser vendors and removed.
    // The maxTouchPoints check handles iPadOS 13+ which reports as 'MacIntel' UA.
    const ios =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent));
    setIsIOS(ios);

    // Android/Chrome install prompt
    const handler = (e: Event): void => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setShowBanner(true);
    };

    window.addEventListener('beforeinstallprompt', handler);

    // For iOS, show manual instructions after a delay
    if (ios) {
      const timer = setTimeout(() => setShowBanner(true), 3000);
      return () => {
        clearTimeout(timer);
        window.removeEventListener('beforeinstallprompt', handler);
      };
    }

    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstall = async (): Promise<void> => {
    if (!deferredPrompt) return;

    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;

    if (outcome === 'accepted') {
      setShowBanner(false);
    }
    setDeferredPrompt(null);
  };

  const handleDismiss = (): void => {
    setShowBanner(false);
    localStorage.setItem(DISMISSED_KEY, Date.now().toString());
  };

  if (!showBanner || isStandalone) return null;

  return (
    <div className="fixed bottom-20 left-4 right-4 z-50 animate-slide-up">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-elevated border border-gray-100 dark:border-gray-800 p-4">
        <div className="flex items-start gap-3">
          <div className="w-12 h-12 bg-ocean-50 dark:bg-ocean-900/20 rounded-xl flex items-center justify-center flex-shrink-0">
            <Smartphone size={24} className="text-ocean-600" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-bold text-gray-900 dark:text-white text-sm">Install AquaMobil</h3>
            {isIOS ? (
              <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                Tap the <span className="inline-flex items-center"><svg className="w-4 h-4 inline text-ocean-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg></span> share button, then <strong>&quot;Add to Home Screen&quot;</strong>
              </p>
            ) : (
              <p className="text-xs text-gray-500 mt-1">
                Add to your home screen for quick access and offline support
              </p>
            )}
          </div>
          <button
            onClick={handleDismiss}
            className="p-1 text-gray-400 hover:text-gray-600 flex-shrink-0"
          >
            <X size={18} />
          </button>
        </div>

        {!isIOS && deferredPrompt && (
          <button
            onClick={() => {
              runAsyncAction(handleInstall, 'pwa-install-prompt');
            }}
            className="w-full mt-3 py-2.5 bg-ocean-600 hover:bg-ocean-700 text-white font-semibold rounded-xl text-sm flex items-center justify-center gap-2 touch-feedback transition-colors"
          >
            <Download size={16} />
            Install App
          </button>
        )}
      </div>
    </div>
  );
}
