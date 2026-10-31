import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTypewriter } from '../useTypewriter';

/** Animation frames the spec runs by hand. */
let frames: FrameRequestCallback[] = [];

function runFrames(count: number): void {
  for (let i = 0; i < count; i++) {
    const due = frames;
    frames = [];
    act(() => due.forEach((frame) => frame(0)));
  }
}

function prefersReducedMotion(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduce && query.includes('reduce') }));
}

describe('useTypewriter (MSG-MEDIUM-089)', () => {
  beforeEach(() => {
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => frames.push(frame));
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('types the text out over a few frames and stops at its end', () => {
    prefersReducedMotion(false);
    const { result } = renderHook(() => useTypewriter('Tank 4 is fine.'));
    expect(result.current).toBe('');

    runFrames(1);
    const afterOne = result.current;
    expect(afterOne.length).toBeGreaterThan(0);
    expect('Tank 4 is fine.'.startsWith(afterOne)).toBe(true);

    runFrames(20);
    expect(result.current).toBe('Tank 4 is fine.');
    expect(frames).toEqual([]);
  });

  it('continues from what it has typed when more text arrives, and starts over when the text does not continue it', () => {
    prefersReducedMotion(false);
    const { result, rerender } = renderHook(({ text }) => useTypewriter(text), {
      initialProps: { text: 'Checking' },
    });
    runFrames(20);
    expect(result.current).toBe('Checking');

    rerender({ text: 'Checking the tanks.' });
    runFrames(1);
    expect(result.current.startsWith('Checking')).toBe(true);
    expect(result.current.length).toBeGreaterThan('Checking'.length);

    rerender({ text: 'All good.' });
    runFrames(1);
    expect('All good.'.startsWith(result.current)).toBe(true);
    expect(result.current.length).toBeLessThan('All good.'.length);
  });

  it('shows the whole text at once for a reader who asked for reduced motion', () => {
    prefersReducedMotion(true);
    const { result } = renderHook(() => useTypewriter('Tank 4 is fine.'));
    expect(result.current).toBe('Tank 4 is fine.');
    expect(frames).toEqual([]);
  });
});
