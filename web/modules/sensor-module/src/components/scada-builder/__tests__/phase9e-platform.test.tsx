/**
 * Phase 9E Platform Features tests.
 *
 * Covers:
 *  1.  ExportDialog renders format selector (PNG/PDF)
 *  2.  ExportDialog default filename is 'scada-export'
 *  3.  TagWatchPanel subscribes to wildcard tag updates
 *  4.  TagWatchPanel search filters by tag name
 *  5.  TagWatchPanel pause stops display updates
 *  6.  RecipePanel saves current tag values as recipe
 *  7.  RecipePanel loads recipe values (verifies tag writes)
 *  8.  RecipePanel deletes a recipe
 *  9.  DaqConfigPanel renders tag list with interval selectors
 * 10.  DaqConfigPanel bulk enable/disable toggles
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
import { RecipePanel, type ScadaRecipe } from '../RecipePanel';
import { DaqConfigPanel, type DaqTagConfig } from '../DaqConfigPanel';
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
/*  RecipePanel Tests                                                  */
/* ------------------------------------------------------------------ */

describe('RecipePanel', () => {
  let tagBus: TagValueBus;

  beforeEach(() => {
    tagBus = new TagValueBus();
  });

  afterEach(() => {
    tagBus.clear();
  });

  it('saves current tag values as a new recipe', () => {
    const onChange = vi.fn();

    // Set up some tag values before saving
    tagBus.publish('temp.sp', 25);
    tagBus.publish('ph.sp', 7.0);

    render(
      <RecipePanel recipes={[]} onRecipesChange={onChange} tagBus={tagBus} />,
    );

    // Click + to open form
    fireEvent.click(screen.getByTitle('Save current tag values as recipe'));

    // Enter name
    const nameInput = screen.getByTestId('recipe-name-input');
    fireEvent.change(nameInput, { target: { value: 'Winter Config' } });

    // Click save
    fireEvent.click(screen.getByTestId('recipe-save-btn'));

    expect(onChange).toHaveBeenCalledOnce();
    const recipes = onChange.mock.calls[0][0] as ScadaRecipe[];
    expect(recipes).toHaveLength(1);
    expect(recipes[0].name).toBe('Winter Config');
    expect(recipes[0].values['temp.sp']).toBe(25);
    expect(recipes[0].values['ph.sp']).toBe(7.0);
  });

  it('loads a recipe and writes values to tag bus', () => {
    const publishSpy = vi.spyOn(tagBus, 'publish');
    const recipe: ScadaRecipe = {
      id: 'r1',
      name: 'Summer Config',
      values: { 'temp.sp': 28, 'ph.sp': 7.5 },
      createdAt: '2026-01-01T00:00:00Z',
    };

    render(
      <RecipePanel recipes={[recipe]} onRecipesChange={() => {}} tagBus={tagBus} />,
    );

    fireEvent.click(screen.getByTestId('recipe-load-r1'));

    // Verify tag writes
    expect(publishSpy).toHaveBeenCalledWith('temp.sp', 28);
    expect(publishSpy).toHaveBeenCalledWith('ph.sp', 7.5);
  });

  it('deletes a recipe from the list', () => {
    const onChange = vi.fn();
    const recipes: ScadaRecipe[] = [
      { id: 'r1', name: 'Config A', values: { x: 1 }, createdAt: '2026-01-01T00:00:00Z' },
      { id: 'r2', name: 'Config B', values: { y: 2 }, createdAt: '2026-01-02T00:00:00Z' },
    ];

    render(
      <RecipePanel recipes={recipes} onRecipesChange={onChange} tagBus={tagBus} />,
    );

    // Find delete button for recipe r1
    const deleteButtons = screen.getAllByTitle('Delete');
    fireEvent.click(deleteButtons[0]);

    expect(onChange).toHaveBeenCalledOnce();
    const updated = onChange.mock.calls[0][0] as ScadaRecipe[];
    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe('r2');
  });

  it('shows empty state when no recipes exist', () => {
    render(
      <RecipePanel recipes={[]} onRecipesChange={() => {}} tagBus={tagBus} />,
    );

    expect(screen.getByText(/No recipes yet/)).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
/*  DaqConfigPanel Tests                                               */
/* ------------------------------------------------------------------ */

describe('DaqConfigPanel', () => {
  const defaultConfigs: DaqTagConfig[] = [
    { tagName: 'temp.sensor1', enabled: true, interval: '15s', deadband: 0, retention: '30d' },
    { tagName: 'ph.sensor1', enabled: true, interval: '5s', deadband: 0.1, retention: '90d' },
    { tagName: 'do.sensor1', enabled: false, interval: '1m', deadband: 0, retention: '7d' },
  ];

  it('renders tag list with interval selectors', () => {
    render(<DaqConfigPanel configs={defaultConfigs} onConfigsChange={() => {}} />);

    expect(screen.getByTestId('daq-tag-temp.sensor1')).toBeTruthy();
    expect(screen.getByTestId('daq-tag-ph.sensor1')).toBeTruthy();
    expect(screen.getByTestId('daq-tag-do.sensor1')).toBeTruthy();

    // Check interval selector is present for enabled tags
    const intervalSelect = screen.getByTestId('daq-interval-temp.sensor1') as HTMLSelectElement;
    expect(intervalSelect.value).toBe('15s');
  });

  it('shows enabled count correctly', () => {
    render(<DaqConfigPanel configs={defaultConfigs} onConfigsChange={() => {}} />);

    expect(screen.getByText('(2/3 enabled)')).toBeTruthy();
  });

  it('bulk enable/disable toggles all visible tags', () => {
    const onChange = vi.fn();
    render(<DaqConfigPanel configs={defaultConfigs} onConfigsChange={onChange} />);

    // Click "All Off"
    fireEvent.click(screen.getByText('All Off'));

    expect(onChange).toHaveBeenCalledOnce();
    const updated = onChange.mock.calls[0][0] as DaqTagConfig[];
    expect(updated.every((c) => !c.enabled)).toBe(true);
  });

  it('updates interval for a specific tag', () => {
    const onChange = vi.fn();
    render(<DaqConfigPanel configs={defaultConfigs} onConfigsChange={onChange} />);

    const intervalSelect = screen.getByTestId('daq-interval-temp.sensor1');
    fireEvent.change(intervalSelect, { target: { value: '1m' } });

    expect(onChange).toHaveBeenCalledOnce();
    const updated = onChange.mock.calls[0][0] as DaqTagConfig[];
    const tempConfig = updated.find((c) => c.tagName === 'temp.sensor1');
    expect(tempConfig?.interval).toBe('1m');
  });

  it('shows empty state when no configs', () => {
    render(<DaqConfigPanel configs={[]} onConfigsChange={() => {}} />);
    expect(screen.getByText(/No DAQ tags configured/)).toBeTruthy();
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
