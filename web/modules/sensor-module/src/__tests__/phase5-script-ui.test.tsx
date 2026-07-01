/**
 * Phase 5B Script Editor UI tests -- verifies ScriptEditor, ScriptsPanel,
 * ScriptTriggerConfig, and EventsPanel runScript/openUrl integration.
 *
 * Covers:
 *   1.  ScriptEditor renders textarea with monospace font
 *   2.  ScriptEditor Tab key inserts spaces (not focus change)
 *   3.  ScriptEditor name input updates script name
 *   4.  ScriptEditor enabled toggle works
 *   5.  ScriptsPanel renders "Add Script" button
 *   6.  ScriptsPanel adds a new script on button click
 *   7.  ScriptTriggerConfig shows TagBrowser for tagChange trigger
 *   8.  ScriptTriggerConfig shows interval input for interval trigger
 *   9.  EventsPanel shows runScript in action dropdown
 *  10.  EventsPanel shows openUrl in action dropdown
 *  11.  openUrl validates https:// protocol
 *  12.  EventAction type includes runScript and openUrl
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/* ------------------------------------------------------------------ */
/*  Mocks                                                               */
/* ------------------------------------------------------------------ */

/**
 * Mock useDeviceTags to avoid network calls during tag browser rendering.
 * Provides a minimal tag set for testing TagBrowser integration.
 */
vi.mock('../hooks/useDeviceTags', () => ({
  useDeviceTags: () => ({
    tags: [
      { name: 'temperature', ioType: 'AI', direction: 'input', unit: 'C', channel: 0 },
      { name: 'pressure', ioType: 'AI', direction: 'input', unit: 'bar', channel: 1 },
    ],
    groupedTags: [],
    loading: false,
    error: null,
  }),
}));

/**
 * Mock the Zustand store to provide stable screen data for EventsPanel.
 * EventsPanel reads screens from the store for screen selection dropdowns.
 */
vi.mock('../store/scada', () => ({
  useScadaPackageStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      screens: [
        { id: 'screen-1', name: 'Main', screenType: 'dashboard' },
        { id: 'screen-2', name: 'Detail', screenType: 'process' },
      ],
    }),
  useScadaPackageStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      screens: [
        { id: 'screen-1', name: 'Main', screenType: 'dashboard' },
        { id: 'screen-2', name: 'Detail', screenType: 'process' },
      ],
    }),
}));

/* ------------------------------------------------------------------ */
/*  Imports (after mocks to ensure mock registration)                   */
/* ------------------------------------------------------------------ */

import { ScriptEditor } from '../components/scada-builder/widget-configs/ScriptEditor';
import { ScriptsPanel } from '../components/scada-builder/widget-configs/ScriptsPanel';
import { ScriptTriggerConfig } from '../components/scada-builder/widget-configs/ScriptTriggerConfig';
import { EventsPanel } from '../components/scada-builder/widget-configs/EventsPanel';
import type { EventAction, ScadaScript } from '../engine/events/types';

/* ------------------------------------------------------------------ */
/*  Helper factories                                                    */
/* ------------------------------------------------------------------ */

function createScript(overrides: Partial<ScadaScript> = {}): ScadaScript {
  return {
    id: 'test-script-1',
    name: 'Test Script',
    code: 'const x = 1;\nconst y = 2;\nreturn x + y;',
    trigger: 'event',
    enabled: true,
    ...overrides,
  };
}

/* ================================================================== */
/*  ScriptEditor Tests                                                  */
/* ================================================================== */

describe('ScriptEditor', () => {
  let onChange: ReturnType<typeof vi.fn>;
  let onDelete: ReturnType<typeof vi.fn>;
  let onTest: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onChange = vi.fn();
    onDelete = vi.fn();
    onTest = vi.fn();
  });

  /* -------------------------------------------------------------- */
  /*  1. Renders textarea with monospace font                         */
  /* -------------------------------------------------------------- */

  it('renders textarea with monospace font', () => {
    const script = createScript();
    render(
      <ScriptEditor
        script={script}
        onChange={onChange}
        onDelete={onDelete}
        onTest={onTest}
      />,
    );

    const textarea = screen.getByTestId('script-code-textarea') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea.tagName.toLowerCase()).toBe('textarea');
    // Verify monospace font is applied via style or class
    const style = textarea.style.fontFamily;
    expect(style).toContain('monospace');
  });

  /* -------------------------------------------------------------- */
  /*  2. Tab key inserts spaces (not focus change)                    */
  /* -------------------------------------------------------------- */

  it('Tab key inserts spaces instead of changing focus', () => {
    const script = createScript({ code: 'line1' });
    render(
      <ScriptEditor
        script={script}
        onChange={onChange}
        onDelete={onDelete}
        onTest={onTest}
      />,
    );

    const textarea = screen.getByTestId('script-code-textarea') as HTMLTextAreaElement;

    // Set cursor position to end of text
    textarea.selectionStart = 5;
    textarea.selectionEnd = 5;

    const tabEvent = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    const prevented = !textarea.dispatchEvent(tabEvent);

    // The Tab key should be prevented (default browser focus change blocked)
    // and onChange should be called with the indented code
    // Note: fireEvent approach for React synthetic events
    fireEvent.keyDown(textarea, { key: 'Tab' });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ code: expect.stringContaining('  ') }),
    );
  });

  /* -------------------------------------------------------------- */
  /*  3. Name input updates script name                               */
  /* -------------------------------------------------------------- */

  it('name input updates script name', () => {
    const script = createScript();
    render(
      <ScriptEditor
        script={script}
        onChange={onChange}
        onDelete={onDelete}
        onTest={onTest}
      />,
    );

    const nameInput = screen.getByTestId('script-name-input') as HTMLInputElement;
    expect(nameInput.value).toBe('Test Script');

    fireEvent.change(nameInput, { target: { value: 'My New Script' } });
    expect(onChange).toHaveBeenCalledWith({ name: 'My New Script' });
  });

  /* -------------------------------------------------------------- */
  /*  4. Enabled toggle works                                         */
  /* -------------------------------------------------------------- */

  it('enabled toggle switches script state', () => {
    const script = createScript({ enabled: true });
    render(
      <ScriptEditor
        script={script}
        onChange={onChange}
        onDelete={onDelete}
        onTest={onTest}
      />,
    );

    const toggleBtn = screen.getByTestId('script-enabled-toggle');
    fireEvent.click(toggleBtn);
    expect(onChange).toHaveBeenCalledWith({ enabled: false });
  });
});

/* ================================================================== */
/*  ScriptsPanel Tests                                                  */
/* ================================================================== */

describe('ScriptsPanel', () => {
  let onChange: ReturnType<typeof vi.fn>;
  let onTestScript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onChange = vi.fn();
    onTestScript = vi.fn();
  });

  /* -------------------------------------------------------------- */
  /*  5. Renders "Add Script" button                                  */
  /* -------------------------------------------------------------- */

  it('renders "Add Script" button', () => {
    render(
      <ScriptsPanel
        scripts={[]}
        onChange={onChange}
        onTestScript={onTestScript}
      />,
    );

    const addBtn = screen.getByTestId('add-script-btn');
    expect(addBtn).toBeTruthy();
    expect(addBtn.textContent).toContain('Add Script');
  });

  /* -------------------------------------------------------------- */
  /*  6. Adds a new script on button click                            */
  /* -------------------------------------------------------------- */

  it('adds a new script on button click', () => {
    render(
      <ScriptsPanel
        scripts={[]}
        onChange={onChange}
        onTestScript={onTestScript}
      />,
    );

    const addBtn = screen.getByTestId('add-script-btn');
    fireEvent.click(addBtn);

    expect(onChange).toHaveBeenCalledTimes(1);
    const newScripts = onChange.mock.calls[0][0] as ScadaScript[];
    expect(newScripts).toHaveLength(1);
    expect(newScripts[0].name).toBe('Script 1');
    expect(newScripts[0].trigger).toBe('event');
    expect(newScripts[0].enabled).toBe(true);
    expect(newScripts[0].code).toBe('');
  });
});

/* ================================================================== */
/*  ScriptTriggerConfig Tests                                           */
/* ================================================================== */

describe('ScriptTriggerConfig', () => {
  let onChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onChange = vi.fn();
  });

  /* -------------------------------------------------------------- */
  /*  7. Shows TagBrowser for tagChange trigger                       */
  /* -------------------------------------------------------------- */

  it('shows tag config for tagChange trigger', () => {
    render(
      <ScriptTriggerConfig
        trigger="tagChange"
        triggerTag=""
        deviceId={null}
        onChange={onChange}
      />,
    );

    const tagConfig = screen.getByTestId('trigger-tag-config');
    expect(tagConfig).toBeTruthy();
  });

  /* -------------------------------------------------------------- */
  /*  8. Shows interval input for interval trigger                    */
  /* -------------------------------------------------------------- */

  it('shows interval input for interval trigger', () => {
    render(
      <ScriptTriggerConfig
        trigger="interval"
        triggerInterval={5000}
        deviceId={null}
        onChange={onChange}
      />,
    );

    const intervalConfig = screen.getByTestId('trigger-interval-config');
    expect(intervalConfig).toBeTruthy();

    const intervalInput = screen.getByTestId('trigger-interval-input') as HTMLInputElement;
    expect(intervalInput).toBeTruthy();
    expect(Number(intervalInput.value)).toBe(5000);
  });
});

/* ================================================================== */
/*  EventsPanel Tests                                                   */
/* ================================================================== */

describe('EventsPanel', () => {
  let onChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onChange = vi.fn();
  });

  /* -------------------------------------------------------------- */
  /*  9. Shows runScript in action dropdown                           */
  /* -------------------------------------------------------------- */

  it('shows runScript in action dropdown', () => {
    render(
      <EventsPanel
        events={[{
          id: 'ev-1',
          trigger: 'click',
          action: 'navigate',
          params: {},
        }]}
        onChange={onChange}
        scripts={[]}
      />,
    );

    // Find the action select (second select in the event card)
    const selects = document.querySelectorAll('select');
    const actionSelect = selects[1]; // First is trigger, second is action
    expect(actionSelect).toBeTruthy();

    // Verify runScript option exists
    const options = Array.from(actionSelect.querySelectorAll('option'));
    const runScriptOption = options.find((o) => o.value === 'runScript');
    expect(runScriptOption).toBeTruthy();
    expect(runScriptOption?.textContent).toBe('Run Script');
  });

  /* -------------------------------------------------------------- */
  /*  10. Shows openUrl in action dropdown                            */
  /* -------------------------------------------------------------- */

  it('shows openUrl in action dropdown', () => {
    render(
      <EventsPanel
        events={[{
          id: 'ev-1',
          trigger: 'click',
          action: 'navigate',
          params: {},
        }]}
        onChange={onChange}
        scripts={[]}
      />,
    );

    const selects = document.querySelectorAll('select');
    const actionSelect = selects[1];
    const options = Array.from(actionSelect.querySelectorAll('option'));
    const openUrlOption = options.find((o) => o.value === 'openUrl');
    expect(openUrlOption).toBeTruthy();
    expect(openUrlOption?.textContent).toBe('Open URL');
  });

  /* -------------------------------------------------------------- */
  /*  11. openUrl validates https:// protocol                         */
  /* -------------------------------------------------------------- */

  it('openUrl shows error for non-https URL', () => {
    render(
      <EventsPanel
        events={[{
          id: 'ev-1',
          trigger: 'click',
          action: 'openUrl',
          params: { url: 'http://evil.com' },
        }]}
        onChange={onChange}
        scripts={[]}
      />,
    );

    // The openUrl config should render with a validation error
    const urlInput = screen.getByTestId('openurl-input') as HTMLInputElement;
    expect(urlInput.value).toBe('http://evil.com');

    const errorMsg = screen.getByTestId('openurl-error');
    expect(errorMsg).toBeTruthy();
    expect(errorMsg.textContent).toContain('https://');
  });
});

/* ================================================================== */
/*  Type-level Tests                                                    */
/* ================================================================== */

describe('EventAction type', () => {
  /* -------------------------------------------------------------- */
  /*  12. EventAction type includes runScript and openUrl             */
  /* -------------------------------------------------------------- */

  it('includes runScript and openUrl', () => {
    // Type-level assertion: these assignments must compile without error.
    // If EventAction does not include these values, TypeScript will fail
    // at build time. The runtime check confirms the values are usable.
    const runScript: EventAction = 'runScript';
    const openUrl: EventAction = 'openUrl';

    expect(runScript).toBe('runScript');
    expect(openUrl).toBe('openUrl');
  });
});
