/**
 * FishBackground — prefers-reduced-motion guard (ORPHAN-MEDIUM-136).
 * The imperative rAF swim loop must NOT start when reduced motion is requested.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

import FishBackground from '../FishBackground';

function setReducedMotion(reduced: boolean): void {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: reduced,
    media: query,
    onchange: null,
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
    addListener: (): void => {},
    removeListener: (): void => {},
    dispatchEvent: (): boolean => false,
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('FishBackground reduced-motion guard', () => {
  it('does NOT start the rAF loop when reduced motion is requested', () => {
    setReducedMotion(true);
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
    render(<FishBackground fishCount={3} />);
    expect(raf).not.toHaveBeenCalled();
  });

  it('starts the rAF loop when motion is allowed', () => {
    setReducedMotion(false);
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
    render(<FishBackground fishCount={3} />);
    expect(raf).toHaveBeenCalled();
  });
});
