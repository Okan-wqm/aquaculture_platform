/**
 * Performance Tests — SCADA Builder Phase 0.4 optimizations.
 *
 * Bu testler Phase 0.4 performans iyilestirmelerini dogrular:
 * 1. AnimationStyles: tek seferlik injection, HMR re-injection, cleanup
 * 2. useTagValues: N+1 subscription yerine wildcard batch, referans kararliligi
 *
 * These tests verify Phase 0.4 performance improvements:
 * 1. AnimationStyles: single injection, HMR re-injection, cleanup
 * 2. useTagValues: wildcard batch instead of N+1 subscriptions, referential stability
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { injectAnimationStyles, removeAnimationStyles } from '../animation/AnimationStyles';
import { TagValueBus } from '../tags/TagValueBus';

/* ================================================================== */
/*  AnimationStyles Tests                                               */
/* ================================================================== */

describe('AnimationStyles', () => {
  const STYLE_ID = 'scada-animation-keyframes';

  afterEach(() => {
    // DOM temizligi — her testten sonra eklenen style element'ini kaldir
    // DOM cleanup — remove any injected style element after each test
    document.getElementById(STYLE_ID)?.remove();
  });

  it('injects a style element into document.head on first call', () => {
    expect(document.getElementById(STYLE_ID)).toBeNull();

    injectAnimationStyles();

    const el = document.getElementById(STYLE_ID);
    expect(el).not.toBeNull();
    expect(el?.tagName.toLowerCase()).toBe('style');
    expect(el?.parentElement).toBe(document.head);
  });

  it('injects only once even if called multiple times (idempotent)', () => {
    // 100+ widget mount edildiginde injectAnimationStyles() cok kez cagrilir
    // DOM'da tek element olmasi gerekir — duplicate injection onlenir
    // When 100+ widgets mount, injectAnimationStyles() is called many times.
    // Only one element should exist in the DOM — duplicate injection is prevented.
    injectAnimationStyles();
    injectAnimationStyles();
    injectAnimationStyles();

    const elements = document.querySelectorAll(`#${STYLE_ID}`);
    expect(elements.length).toBe(1);
  });

  it('removeAnimationStyles cleans up the DOM element', () => {
    injectAnimationStyles();
    expect(document.getElementById(STYLE_ID)).not.toBeNull();

    removeAnimationStyles();

    // Element DOM'dan kaldirilmis olmali
    // Element should be removed from the DOM
    expect(document.getElementById(STYLE_ID)).toBeNull();
  });

  it('re-injects after removal (HMR / MFE remount scenario)', () => {
    // HMR sirasinda module yeniden yuklendiginde:
    // 1. Eski component unmount olur -> removeAnimationStyles() cagirilir
    // 2. Yeni component mount olur -> injectAnimationStyles() tekrar cagrilir
    // DOM-based kontrol sayesinde boolean flag'dan farkli olarak dogru calisir.
    //
    // During HMR when the module reloads:
    // 1. Old component unmounts -> removeAnimationStyles() is called
    // 2. New component mounts -> injectAnimationStyles() is called again
    // DOM-based check works correctly unlike a module-level boolean flag.
    injectAnimationStyles();
    expect(document.getElementById(STYLE_ID)).not.toBeNull();

    removeAnimationStyles();
    expect(document.getElementById(STYLE_ID)).toBeNull();

    injectAnimationStyles();
    const el = document.getElementById(STYLE_ID);
    expect(el).not.toBeNull();
    expect(el?.textContent).toContain('scada-rotate-cw');
  });

  it('injected CSS contains handle hover styles (moved from per-widget injection)', () => {
    // Daha once her ScadaWidgetNode icinde <style>{HANDLE_HOVER_CSS}</style> vardi.
    // Artik global injection'a tasindi — burada CSS'in icerdigini dogruluyoruz.
    //
    // Previously each ScadaWidgetNode had <style>{HANDLE_HOVER_CSS}</style>.
    // Now moved to global injection — verify the CSS content here.
    injectAnimationStyles();

    const el = document.getElementById(STYLE_ID);
    const css = el?.textContent ?? '';

    // Handle hover effects
    expect(css).toContain('.react-flow__handle:hover');
    expect(css).toContain('transform: scale(1.5)');

    // Handle connecting animation
    expect(css).toContain('.react-flow__handle.connecting');
    expect(css).toContain('handle-pulse');

    // Animation keyframes (pre-existing)
    expect(css).toContain('scada-rotate-cw');
    expect(css).toContain('scada-rotate-ccw');
    expect(css).toContain('scada-blink');
    expect(css).toContain('scada-pipe-flow');
  });

  it('removeAnimationStyles is safe to call when no element exists (no-op)', () => {
    // Defensive: element yokken remove cagirilirsa hata vermemeli
    // Defensive: calling remove when no element exists should not throw
    expect(document.getElementById(STYLE_ID)).toBeNull();
    expect(() => removeAnimationStyles()).not.toThrow();
  });
});

/* ================================================================== */
/*  useTagValues — TagValueBus wildcard subscription tests              */
/* ================================================================== */

describe('useTagValues — TagValueBus wildcard subscription behavior', () => {
  /**
   * Bu testler hook'un dayandigi TagValueBus mekanizmasini dogrular:
   * - Wildcard ('*') subscription tum tag guncellemelerini alir
   * - Ilgisiz tag'lar filtrelenir
   * - Ayni deger tekrar gonderildiginde gereksiz callback tetiklenmez
   *
   * These tests verify the TagValueBus mechanisms the hook relies on:
   * - Wildcard ('*') subscription receives all tag updates
   * - Unrelated tags are filtered
   * - Sending the same value again does not need extra callbacks
   *
   * Not: useTagValues hook'u bir React hook'u oldugundan renderHook gerektirir.
   * Burada bus mekanizmasinin kendisini test ediyoruz cunku hook sadece subscribe/filter yapar.
   *
   * Note: useTagValues is a React hook and would require renderHook to test directly.
   * Here we test the bus mechanism itself since the hook simply subscribes and filters.
   */
  let bus: TagValueBus;

  beforeEach(() => {
    bus = new TagValueBus();
  });

  it('wildcard subscription receives updates from N tags in sequence', () => {
    // N tag guncellemesi wildcard'a N callback olarak gelir
    // React 18 automatic batching bu callback'leri tek re-render'a dusurecek
    //
    // N tag updates arrive as N callbacks to the wildcard listener.
    // React 18 automatic batching will reduce these to a single re-render.
    const received: Array<{ name: string; val: unknown }> = [];

    bus.subscribe('*', (val, name) => {
      received.push({ name, val });
    });

    bus.publish('pump1.rpm', 1450);
    bus.publish('tank1.level', 72.5);
    bus.publish('ph.value', 7.2);

    expect(received).toEqual([
      { name: 'pump1.rpm', val: 1450 },
      { name: 'tank1.level', val: 72.5 },
      { name: 'ph.value', val: 7.2 },
    ]);
  });

  it('publishBatch triggers wildcard for all tags in one synchronous pass', () => {
    // publishBatch ile N tag tek seferde guncellenir
    // Wildcard listener her tag icin bir kez cagrilir — hepsi ayni microtask'ta
    //
    // publishBatch updates N tags in one call.
    // Wildcard listener is invoked once per tag — all within the same microtask.
    const callCount = vi.fn();

    bus.subscribe('*', callCount);

    bus.publishBatch({
      'sensor1': 100,
      'sensor2': 200,
      'sensor3': 300,
    });

    // 3 tag = 3 callback cagrisi, ama hepsi senkron — React batching birlestirir
    // 3 tags = 3 callback invocations, but all synchronous — React batching merges
    expect(callCount).toHaveBeenCalledTimes(3);
  });

  it('filtering unrelated tags works with a Set lookup (simulates useTagValues behavior)', () => {
    // useTagValues hook'u tagSetRef.current.has(name) kontrolu yapar
    // Sadece ilgili tag'lar icin setState cagirilir
    //
    // The useTagValues hook checks tagSetRef.current.has(name).
    // Only relevant tags trigger setState.
    const tagSet = new Set(['pump1.rpm', 'tank1.level']);
    const relevantUpdates: Array<{ name: string; val: unknown }> = [];

    bus.subscribe('*', (val, name) => {
      if (tagSet.has(name)) {
        relevantUpdates.push({ name, val });
      }
    });

    bus.publish('pump1.rpm', 1450);     // relevant
    bus.publish('unrelated.tag', 999);  // filtered out
    bus.publish('tank1.level', 72.5);   // relevant
    bus.publish('another.tag', 123);    // filtered out

    expect(relevantUpdates).toHaveLength(2);
    expect(relevantUpdates[0]).toEqual({ name: 'pump1.rpm', val: 1450 });
    expect(relevantUpdates[1]).toEqual({ name: 'tank1.level', val: 72.5 });
  });

  it('referential equality check prevents unnecessary state updates', () => {
    // useTagValues icinde: if (prev[name] === val) return prev;
    // Bu kontrol ayni deger tekrar gonderildiginde spread + yeni obje olusumunu onler
    //
    // Inside useTagValues: if (prev[name] === val) return prev;
    // This check prevents spread + new object creation when the same value is re-sent.
    const stateUpdates = vi.fn();
    const currentState: Record<string, unknown> = { 'pump1.rpm': 1450 };

    bus.subscribe('*', (val, name) => {
      // Simulate useTagValues' setState logic
      if (currentState[name] === val) {
        // Referans esitligi — state degismez, re-render tetiklenmez
        // Referential equality — state unchanged, no re-render triggered
        return;
      }
      currentState[name] = val;
      stateUpdates();
    });

    bus.publish('pump1.rpm', 1450); // Same value — should not trigger state update
    expect(stateUpdates).not.toHaveBeenCalled();

    bus.publish('pump1.rpm', 1500); // Different value — should trigger
    expect(stateUpdates).toHaveBeenCalledTimes(1);
  });

  it('wildcard subscription can be unsubscribed cleanly', () => {
    const cb = vi.fn();
    const unsub = bus.subscribe('*', cb);

    bus.publish('tag1', 1);
    expect(cb).toHaveBeenCalledTimes(1);

    unsub();

    bus.publish('tag2', 2);
    // Unsub sonrasi callback cagirilmamali
    // After unsub, callback should not be invoked
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('N simultaneous tag updates via publishBatch result in single microtask callbacks', () => {
    // Bu test 100 tag'in ayni anda guncellenmesini simule eder.
    // Tum callback'ler senkron olarak gerceklesir — React 18 batching
    // tek bir re-render uretir.
    //
    // This test simulates 100 tags updating simultaneously.
    // All callbacks execute synchronously — React 18 batching
    // produces a single re-render.
    const batch: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      batch[`sensor_${i}`] = Math.random() * 100;
    }

    const tagSet = new Set(Object.keys(batch).slice(0, 10)); // Only care about first 10
    let stateUpdateCount = 0;

    bus.subscribe('*', (_val, name) => {
      if (tagSet.has(name)) {
        stateUpdateCount++;
      }
    });

    bus.publishBatch(batch);

    // 100 tag yayinlandi ama sadece 10 tanesi filtrelendi
    // 100 tags published but only 10 passed the filter
    expect(stateUpdateCount).toBe(10);
  });
});
