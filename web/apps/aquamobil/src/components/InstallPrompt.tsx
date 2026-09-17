/**
 * InstallPrompt — the "add AquaMobil to your home screen" invitation.
 *
 * WHY it is the kit's <Sheet> and not a hand-rolled banner (ORPHAN-MEDIUM-573):
 * this was one of three overlays the app rolled by hand, and none of them
 * trapped focus or returned it to the opener — a keyboard or screen-reader user
 * met a dialog they could tab straight out of and then had to hunt for their
 * place again. <Sheet> owns that whole contract in one place: Escape closes,
 * focus enters on open and returns on close, Tab wraps inside the panel, the
 * page behind stops scrolling, and the scrim is a real, keyboard-operable
 * button. Adopting it deletes the bespoke overlay rather than re-fixing it here.
 *
 * Dismissal semantics are unchanged in substance and now cover every exit: the
 * sheet's Close, its scrim and Escape all run `handleDismiss`, so the 24-hour
 * suppression is recorded however the worker gets out — previously only the X
 * recorded it.
 */
import { Download, Smartphone } from 'lucide-react';
import { useState, useEffect, type ReactElement } from 'react';

import { Button, Sheet } from '@/components/ui';
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
      window.matchMedia('(display-mode: standalone)').matches || isIosStandalone(window.navigator);
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
    // `open` is a literal because the guard above already decided visibility —
    // keeping it means Sheet's scroll lock and focus trap are only ever mounted
    // while the prompt is actually on screen.
    <Sheet
      open
      onClose={handleDismiss}
      title="Install AquaMobil"
      footer={
        !isIOS && deferredPrompt ? (
          <Button
            variant="primary"
            block
            onClick={() => {
              runAsyncAction(handleInstall, 'pwa-install-prompt');
            }}
          >
            <Download size={16} aria-hidden />
            Install App
          </Button>
        ) : undefined
      }
    >
      <div className="px-5 pb-5 flex items-start gap-3">
        <div className="w-12 h-12 bg-acc-dim rounded-xl flex items-center justify-center shrink-0">
          <Smartphone size={24} className="text-acc" aria-hidden />
        </div>
        {isIOS ? (
          <p className="text-body text-ink-2 leading-relaxed">
            Tap the{' '}
            <span className="inline-flex items-center">
              {/* aria-hidden: the sentence already names the share button, so the
                  glyph is a picture of the word beside it and nothing more. */}
              <svg
                className="w-4 h-4 inline text-acc"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                />
              </svg>
            </span>{' '}
            share button, then <strong>&quot;Add to Home Screen&quot;</strong>
          </p>
        ) : (
          <p className="text-body text-ink-2 leading-relaxed">
            Add to your home screen for quick access and offline support
          </p>
        )}
      </div>
    </Sheet>
  );
}
