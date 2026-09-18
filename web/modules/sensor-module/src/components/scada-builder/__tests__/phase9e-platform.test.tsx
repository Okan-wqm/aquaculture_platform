/**
 * Phase 9E Platform Features tests.
 *
 * Covers:
 *  1.  ExportDialog renders format selector (PNG/PDF)
 *  2.  ExportDialog default filename is 'scada-export'
 *  3.  TagWatchPanel subscribes to wildcard tag updates
 *  4.  TagWatchPanel search filters by tag name
 *  5.  TagWatchPanel pause stops display updates
 * 11.  useTranslation resolves $t: prefix keys
 * 12.  useTranslation falls back to key when translation missing
 * 13.  useTranslation passes through plain strings
 * 14.  ViewTranslations round-trips through JSON serialization
 * 15.  ViewTranslations getAllTranslationKeys returns unique sorted keys
 */

import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Feature imports
import { ExportDialog } from '../ExportDialog';
import { TagWatchPanel } from '../TagWatchPanel';
import { TagValueBus } from '../../../engine/tags/TagValueBus';
import { useTranslation } from '../../../engine/i18n/useTranslation';
import {
  type ViewTranslations,
  resolveLabel,
  createEmptyTranslations,
  getAllTranslationKeys,
  isTranslationKey,
  extractTranslationKey,
} from '../../../engine/i18n/ViewTranslations';

/* ------------------------------------------------------------------ */
/*  ExportDialog Tests                                                 */
/* ------------------------------------------------------------------ */

describe('ExportDialog', () => {
  it('renders format selector with PNG and PDF options', () => {
    render(<ExportDialog isOpen onClose={() => {}} />);

    expect(screen.getByText('PNG')).toBeTruthy();
    expect(screen.getByText('PDF')).toBeTruthy();
  });

  it('renders resolution options (1x, 2x, 3x)', () => {
    render(<ExportDialog isOpen onClose={() => {}} />);

    expect(screen.getByText(/1x/)).toBeTruthy();
    expect(screen.getByText(/2x/)).toBeTruthy();
    expect(screen.getByText(/3x/)).toBeTruthy();
  });

  it('has default filename "scada-export"', () => {
    render(<ExportDialog isOpen onClose={() => {}} />);

    const input = screen.getByPlaceholderText('scada-export') as HTMLInputElement;
    expect(input.value).toBe('scada-export');
  });

  it('does not render when isOpen is false', () => {
    const { container } = render(<ExportDialog isOpen={false} onClose={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('calls onClose when Cancel is clicked', () => {
    const onClose = vi.fn();
    render(<ExportDialog isOpen onClose={onClose} />);

    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

/* ------------------------------------------------------------------ */
/*  TagWatchPanel Tests                                                */
/* ------------------------------------------------------------------ */

describe('TagWatchPanel', () => {
  let tagBus: TagValueBus;

  beforeEach(() => {
    tagBus = new TagValueBus();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    tagBus.clear();
  });

  it('subscribes to wildcard tag updates and shows tag count', () => {
    render(<TagWatchPanel tagBus={tagBus} />);

    // Initially 0 tags
    expect(screen.getByText('(0 tags)')).toBeTruthy();

    // Publish a tag
    act(() => {
      tagBus.publish('temp.sensor1', 25.5);
      vi.advanceTimersByTime(300); // Trigger refresh interval
    });

    expect(screen.getByText('(1 tags)')).toBeTruthy();
  });

  it('displays tag values after bus updates', () => {
    render(<TagWatchPanel tagBus={tagBus} />);

    act(() => {
      tagBus.publish('ph.sensor1', 7.2);
      tagBus.publish('do.sensor1', 8.1);
      vi.advanceTimersByTime(300);
    });

    expect(screen.getByText('ph.sensor1')).toBeTruthy();
    expect(screen.getByText('do.sensor1')).toBeTruthy();
  });

  it('search filters by tag name', () => {
    render(<TagWatchPanel tagBus={tagBus} />);

    act(() => {
      tagBus.publish('temp.sensor1', 25.5);
      tagBus.publish('ph.sensor1', 7.2);
      vi.advanceTimersByTime(300);
    });

    const searchInput = screen.getByTestId('tag-watch-search');
    fireEvent.change(searchInput, { target: { value: 'temp' } });

    // temp.sensor1 should be visible, ph.sensor1 should not
    expect(screen.getByText('temp.sensor1')).toBeTruthy();
    expect(screen.queryByText('ph.sensor1')).toBeNull();
  });

  it('pause button stops display updates', () => {
    render(<TagWatchPanel tagBus={tagBus} />);

    // Publish and verify tag appears
    act(() => {
      tagBus.publish('temp.sensor1', 25.5);
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText('(1 tags)')).toBeTruthy();

    // Click pause
    const pauseBtn = screen.getByTitle('Pause');
    fireEvent.click(pauseBtn);

    // Publish another tag — count should remain 1 since display is paused
    act(() => {
      tagBus.publish('ph.sensor1', 7.2);
      vi.advanceTimersByTime(300);
    });

    // The count display should still show 1 (paused)
    expect(screen.getByText('(1 tags)')).toBeTruthy();
  });

  it('clear history resets all entries', () => {
    render(<TagWatchPanel tagBus={tagBus} />);

    act(() => {
      tagBus.publish('temp.sensor1', 25.5);
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText('(1 tags)')).toBeTruthy();

    fireEvent.click(screen.getByTitle('Clear history'));

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(screen.getByText('(0 tags)')).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
/*  useTranslation Hook Tests                                          */
/* ------------------------------------------------------------------ */

describe('useTranslation', () => {
  const translations: ViewTranslations = {
    defaultLanguage: 'en',
    languages: {
      en: { pump_status: 'Pump Status', water_level: 'Water Level', greeting: 'Hello' },
      tr: { pump_status: 'Pompa Durumu', water_level: 'Su Seviyesi' },
    },
  };

  it('resolves $t: prefix keys to translated text', () => {
    const { result } = renderHook(() => useTranslation(translations, 'en'));

    expect(result.current.t('$t:pump_status')).toBe('Pump Status');
    expect(result.current.t('$t:water_level')).toBe('Water Level');
  });

  it('resolves to requested language when available', () => {
    const { result } = renderHook(() => useTranslation(translations, 'tr'));

    expect(result.current.t('$t:pump_status')).toBe('Pompa Durumu');
    expect(result.current.t('$t:water_level')).toBe('Su Seviyesi');
  });

  it('falls back to default language when key missing in requested language', () => {
    const { result } = renderHook(() => useTranslation(translations, 'tr'));

    // 'greeting' exists in 'en' but not in 'tr' — should fall back to English
    expect(result.current.t('$t:greeting')).toBe('Hello');
  });

  it('falls back to raw key when translation is missing entirely', () => {
    const { result } = renderHook(() => useTranslation(translations, 'en'));

    expect(result.current.t('$t:nonexistent_key')).toBe('nonexistent_key');
  });

  it('passes through plain strings without $t: prefix', () => {
    const { result } = renderHook(() => useTranslation(translations, 'en'));

    expect(result.current.t('Static Label')).toBe('Static Label');
    expect(result.current.t('')).toBe('');
    expect(result.current.t('No translation needed')).toBe('No translation needed');
  });

  it('handles null translations gracefully', () => {
    const { result } = renderHook(() => useTranslation(null, 'en'));

    expect(result.current.t('$t:pump_status')).toBe('$t:pump_status');
    expect(result.current.t('Plain text')).toBe('Plain text');
  });

  it('isKey correctly identifies translation keys', () => {
    const { result } = renderHook(() => useTranslation(translations, 'en'));

    expect(result.current.isKey('$t:pump_status')).toBe(true);
    expect(result.current.isKey('Plain text')).toBe(false);
    expect(result.current.isKey('')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  ViewTranslations Pure Function Tests                               */
/* ------------------------------------------------------------------ */

describe('ViewTranslations', () => {
  it('round-trips through JSON serialization', () => {
    const original: ViewTranslations = {
      defaultLanguage: 'en',
      languages: {
        en: { pump: 'Pump', valve: 'Valve' },
        tr: { pump: 'Pompa', valve: 'Vana' },
      },
    };

    const json = JSON.stringify(original);
    const parsed = JSON.parse(json) as ViewTranslations;

    expect(parsed.defaultLanguage).toBe(original.defaultLanguage);
    expect(parsed.languages.en.pump).toBe('Pump');
    expect(parsed.languages.tr.valve).toBe('Vana');
    expect(Object.keys(parsed.languages)).toHaveLength(2);
  });

  it('getAllTranslationKeys returns unique sorted keys across all languages', () => {
    const translations: ViewTranslations = {
      defaultLanguage: 'en',
      languages: {
        en: { pump: 'Pump', valve: 'Valve', level: 'Level' },
        tr: { pump: 'Pompa', flow: 'Debi' },
      },
    };

    const keys = getAllTranslationKeys(translations);
    expect(keys).toEqual(['flow', 'level', 'pump', 'valve']);
  });

  it('createEmptyTranslations creates valid structure', () => {
    const empty = createEmptyTranslations('tr');
    expect(empty.defaultLanguage).toBe('tr');
    expect(empty.languages.tr).toEqual({});
  });

  it('isTranslationKey detects $t: prefix correctly', () => {
    expect(isTranslationKey('$t:pump')).toBe(true);
    expect(isTranslationKey('$t:')).toBe(true);
    expect(isTranslationKey('pump')).toBe(false);
    expect(isTranslationKey('')).toBe(false);
  });

  it('extractTranslationKey strips $t: prefix', () => {
    expect(extractTranslationKey('$t:pump_status')).toBe('pump_status');
    expect(extractTranslationKey('$t:')).toBe('');
  });

  it('resolveLabel handles mixed translation and plain labels', () => {
    const translations: ViewTranslations = {
      defaultLanguage: 'en',
      languages: { en: { temp: 'Temperature' } },
    };

    expect(resolveLabel('$t:temp', translations, 'en')).toBe('Temperature');
    expect(resolveLabel('Static', translations, 'en')).toBe('Static');
    expect(resolveLabel('$t:missing', translations, 'en')).toBe('missing');
  });
});
