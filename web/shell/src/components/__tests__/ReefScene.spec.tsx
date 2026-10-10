/**
 * ReefScene — the login background (FE-HIGH-313), and the reduced-motion
 * guard it inherits from the scene it replaced (ORPHAN-MEDIUM-136): the
 * animation loop must not start when the user asked for reduced motion.
 */
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ReefScene from '../ReefScene';
import { REEF_SCENE_TAG, ReefSceneElement } from '../reef/ReefSceneElement';
import { ROSTERS, SCHOOL_SIZE } from '../reef/species';

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

function scene(container: HTMLElement): ReefSceneElement {
  const el = container.querySelector(REEF_SCENE_TAG);
  if (!(el instanceof ReefSceneElement)) throw new Error('the reef scene did not upgrade');
  return el;
}

function fishCount(el: ReefSceneElement): number {
  return el.shadowRoot?.querySelectorAll('.fish-back .fish, .fish-front .fish').length ?? 0;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ReefScene', () => {
  it('is decoration: hidden from assistive technology, styled inside its own shadow root', () => {
    setReducedMotion(true);
    const { container } = render(<ReefScene />);
    const el = scene(container);
    expect(el.getAttribute('aria-hidden')).toBe('true');
    // The stylesheet lives in the shadow root (vitest stubs CSS content, so only its place is checked).
    expect(el.shadowRoot?.querySelector('style')).not.toBeNull();
    expect(document.head.querySelectorAll('style').length).toBe(0);
  });

  it('swims the roster for its density plus the baitfish school', () => {
    setReducedMotion(true);
    const { container } = render(<ReefScene density="low" />);
    const el = scene(container);
    expect(fishCount(el)).toBe(ROSTERS.low.length);
    expect(el.shadowRoot?.querySelectorAll('.school-far .fish').length).toBe(SCHOOL_SIZE.low);
  });

  it('rebuilds the roster when the density changes', () => {
    setReducedMotion(true);
    const { container, rerender } = render(<ReefScene density="low" />);
    rerender(<ReefScene density="high" />);
    expect(fishCount(scene(container))).toBe(ROSTERS.high.length);
  });

  it('gives every fish its own gradient ids', () => {
    setReducedMotion(true);
    const { container } = render(<ReefScene density="med" />);
    const ids = [...(scene(container).shadowRoot?.querySelectorAll('.fish [id]') ?? [])].map(
      (node) => node.id,
    );
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some((id) => id.includes('__ID__'))).toBe(false);
  });

  it('hides the plant layer when plants is false', () => {
    setReducedMotion(true);
    const { container } = render(<ReefScene plants={false} />);
    const plants = scene(container).shadowRoot?.querySelector<HTMLElement>('.plants');
    expect(plants?.style.display).toBe('none');
  });

  it('does NOT start the animation loop when reduced motion is requested', () => {
    setReducedMotion(true);
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
    const { container } = render(<ReefScene />);
    expect(raf).not.toHaveBeenCalled();
    expect(scene(container).animating).toBe(false);
  });

  it('starts the loop when motion is allowed and cancels it on unmount', () => {
    setReducedMotion(false);
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(7);
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const { container, unmount } = render(<ReefScene />);
    const el = scene(container);
    expect(raf).toHaveBeenCalled();
    expect(el.animating).toBe(true);
    unmount();
    expect(cancel).toHaveBeenCalledWith(7);
    expect(el.animating).toBe(false);
  });
});
