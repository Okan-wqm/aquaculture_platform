import { useEffect, useRef, useState } from 'react';

/** Frames the shown text takes to catch up with what has arrived (~100 ms at 60 Hz). */
const CATCH_UP_FRAMES = 6;

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function prefersReducedMotion(): boolean {
  return window.matchMedia(REDUCED_MOTION).matches;
}

/**
 * The part of `text` to show now, so a reply that arrives in chunks reads as
 * if it were being typed (MSG-MEDIUM-089). After each chunk the shown part
 * catches up within CATCH_UP_FRAMES animation frames, faster the further it
 * is behind. A text that does not continue the shown part (the reply started
 * over) is typed from the start. A reader who asked for reduced motion sees
 * the whole text at once.
 */
export function useTypewriter(text: string): string {
  const [reducedMotion] = useState(prefersReducedMotion);
  const [shown, setShown] = useState('');
  const shownRef = useRef('');

  useEffect(() => {
    if (reducedMotion) return undefined;
    let frame = 0;
    const step = (): void => {
      const typed = text.startsWith(shownRef.current) ? shownRef.current.length : 0;
      const behind = text.length - typed;
      const next = text.slice(0, typed + Math.max(1, Math.ceil(behind / CATCH_UP_FRAMES)));
      shownRef.current = next;
      setShown(next);
      if (next.length < text.length) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [text, reducedMotion]);

  return reducedMotion ? text : shown;
}
