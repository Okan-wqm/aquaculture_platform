/**
 * AnimationStyles — Global CSS injection for SCADA animation keyframes and handle hover effects.
 *
 * Performans: Tum animasyon ve hover CSS'leri tek bir <style> tag'inda inject edilir.
 * 100+ widget'li canvas'ta her widget icin ayri <style> yerine tek global injection
 * yaparak DOM bloat onlenir.
 *
 * Performance: All animation and hover CSS is injected in a single <style> tag.
 * Instead of a per-widget <style> tag for 100+ widgets, one global injection
 * prevents DOM bloat.
 */
import { useEffect } from 'react';

/**
 * DOM element ID used to detect whether styles have already been injected.
 *
 * HMR ve MFE unmount/remount durumunda module-level boolean flag yaniltici olur:
 * module hot-reload sırasında flag "true" kalır ama DOM'daki element silinmistir.
 * DOM'da element var mi kontrolu her zaman dogru sonuc verir.
 *
 * In HMR and MFE unmount/remount scenarios a module-level boolean flag is unreliable:
 * during hot-reload the flag stays "true" but the DOM element may have been removed.
 * Checking the DOM directly is always accurate.
 */
const STYLE_ELEMENT_ID = 'scada-animation-keyframes';

/**
 * Combined CSS: animation keyframes + handle hover effects.
 *
 * Handle hover CSS daha once her ScadaWidgetNode icinde <style> tag'i olarak render ediliyordu.
 * Artik tek global injection ile tum node'lar ayni CSS'i paylasir.
 *
 * Handle hover CSS was previously rendered as a <style> tag inside every ScadaWidgetNode.
 * Now all nodes share the same CSS via a single global injection.
 */
const CSS = `
@keyframes scada-rotate-cw { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
@keyframes scada-rotate-ccw { from{transform:rotate(0deg)} to{transform:rotate(-360deg)} }
@keyframes scada-blink { 0%,100%{opacity:1} 50%{opacity:0.12} }
@keyframes scada-pipe-flow { from{stroke-dashoffset:24} to{stroke-dashoffset:0} }
@keyframes scada-pipe-flow-rev { from{stroke-dashoffset:0} to{stroke-dashoffset:24} }
@keyframes scada-piston {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(var(--piston-distance, -20px)); }
}
@keyframes scada-fade-in { from{opacity:0;transform:scale(.96)} to{opacity:1;transform:scale(1)} }
@keyframes handle-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(6, 182, 212, 0.4); }
  50% { box-shadow: 0 0 0 6px rgba(6, 182, 212, 0); }
}
.scada-pump-spinning { animation: scada-rotate-cw var(--scada-spin-speed, 2s) linear infinite; transform-origin: center center; }
.scada-blinking { animation: scada-blink var(--scada-blink-interval, 1s) ease-in-out infinite; }
.scada-pipe-flowing { animation: scada-pipe-flow var(--scada-flow-speed, 0.6s) linear infinite; }
.scada-pipe-flowing-rev { animation: scada-pipe-flow-rev var(--scada-flow-speed, 0.6s) linear infinite; }
.scada-pistoning { animation: scada-piston var(--piston-duration, 1s) ease-in-out infinite; }
.react-flow__handle:hover {
  transform: scale(1.5);
  box-shadow: 0 0 6px 2px rgba(6, 182, 212, 0.5);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.react-flow__handle.connecting {
  animation: handle-pulse 1s ease-in-out infinite;
}
`;

/**
 * Inject global SCADA animation + handle hover styles into <head>.
 *
 * Idempotent: DOM'da zaten varsa tekrar inject etmez.
 * Idempotent: will not re-inject if the element already exists in the DOM.
 */
export function injectAnimationStyles(): void {
  if (document.getElementById(STYLE_ELEMENT_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

/**
 * Remove global SCADA animation styles from the DOM.
 *
 * MFE unmount edildiginde style element'i temizlenir — bellek sizintisi onlenir.
 * When the MFE unmounts the style element is cleaned up — prevents memory leaks.
 */
export function removeAnimationStyles(): void {
  document.getElementById(STYLE_ELEMENT_ID)?.remove();
}

/**
 * React component wrapper: injects on mount, cleans up on unmount.
 *
 * ScadaRuntime icinde <AnimationStyles /> olarak kullanilir.
 * Used as <AnimationStyles /> inside ScadaRuntime.
 */
export function AnimationStyles(): null {
  useEffect(() => {
    injectAnimationStyles();

    // MFE unmount'ta cleanup — HMR'da style kaybolursa tekrar inject edilir
    // Cleanup on MFE unmount — if style disappears during HMR it gets re-injected
    return () => {
      removeAnimationStyles();
    };
  }, []);
  return null;
}
