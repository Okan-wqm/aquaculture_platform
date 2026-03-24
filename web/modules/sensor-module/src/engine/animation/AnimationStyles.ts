import { useEffect } from 'react';

const CSS = `
@keyframes scada-rotate-cw { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
@keyframes scada-rotate-ccw { from{transform:rotate(0deg)} to{transform:rotate(-360deg)} }
@keyframes scada-blink { 0%,100%{opacity:1} 50%{opacity:0.12} }
@keyframes scada-pipe-flow { from{stroke-dashoffset:24} to{stroke-dashoffset:0} }
@keyframes scada-pipe-flow-rev { from{stroke-dashoffset:0} to{stroke-dashoffset:24} }
@keyframes scada-fade-in { from{opacity:0;transform:scale(.96)} to{opacity:1;transform:scale(1)} }
.scada-pump-spinning { animation: scada-rotate-cw var(--scada-spin-speed, 2s) linear infinite; transform-origin: center center; }
.scada-blinking { animation: scada-blink var(--scada-blink-interval, 1s) ease-in-out infinite; }
.scada-pipe-flowing { animation: scada-pipe-flow var(--scada-flow-speed, 0.6s) linear infinite; }
.scada-pipe-flowing-rev { animation: scada-pipe-flow-rev var(--scada-flow-speed, 0.6s) linear infinite; }
`;

let injected = false;

export function AnimationStyles(): null {
  useEffect(() => {
    if (injected) return;
    const el = document.createElement('style');
    el.id = 'scada-animation-keyframes';
    el.textContent = CSS;
    document.head.appendChild(el);
    injected = true;
  }, []);
  return null;
}
