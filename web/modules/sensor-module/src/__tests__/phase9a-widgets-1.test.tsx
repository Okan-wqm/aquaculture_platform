/**
 * Phase 9A Widget Tests (Part 1): DataTable, IFrame, ProgressBar
 *
 * Covers:
 *   1. DataTable renders correct number of columns
 *   2. DataTable pagination shows correct page count
 *   3. IFrame validates https-only URLs
 *   4. IFrame applies sandbox attribute
 *   5. IFrame rejects javascript: and data: URLs
 *   6. ProgressBar renders fill at correct width percentage
 *   7. ProgressBar applies zone colors based on value
 *   8. ProgressBar shows percentage label
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

/* ------------------------------------------------------------------ */
/*  Mocks                                                              */
/* ------------------------------------------------------------------ */

// TagBrowser relies on useDeviceTags which hits the API.
// Mock it to isolate component-level tests.
vi.mock('../components/scada-builder/TagBrowser', () => ({
  TagBrowser: ({
    value,
    onChange,
    placeholder,
  }: {
    deviceId: string | null;
    value: string;
    onChange: (tag: string) => void;
    placeholder?: string;
  }) => (
    <div data-testid="tag-browser" data-value={value}>
      <input
        data-testid="tag-browser-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  ),
}));

// ExpressionBindingSection is not under test here
vi.mock('../components/scada-builder/widget-configs/ExpressionBindingSection', () => ({
  ExpressionBindingSection: () => <div data-testid="expression-binding" />,
}));

/* ------------------------------------------------------------------ */
/*  Imports (after mocks)                                              */
/* ------------------------------------------------------------------ */

const DataTableRenderer = (
  await import('../components/scada-builder/widget-renderers/DataTableRenderer')
).default;

const IFrameRenderer = (
  await import('../components/scada-builder/widget-renderers/IFrameRenderer')
).default;

const ProgressBarRenderer = (
  await import('../components/scada-builder/widget-renderers/ProgressBarRenderer')
).default;

// Import the URL validator directly for unit testing
const { validateIFrameUrl } = await import(
  '../components/scada-builder/widget-renderers/IFrameRenderer'
);

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

interface RendererProps {
  config: Record<string, unknown>;
  width?: number;
  height?: number;
  isEditing?: boolean;
  value?: number | string | boolean;
}

function renderWidget(
  Component: React.FC<{
    config: Record<string, unknown>;
    width: number;
    height: number;
    isEditing: boolean;
    value?: number | string | boolean;
  }>,
  props: RendererProps,
) {
  return render(
    <Component
      config={props.config}
      width={props.width ?? 600}
      height={props.height ?? 400}
      isEditing={props.isEditing ?? true}
      value={props.value}
    />,
  );
}

/* ------------------------------------------------------------------ */
/*  DataTable Tests                                                    */
/* ------------------------------------------------------------------ */

describe('DataTableRenderer', () => {
  const threeColumns = [
    { tagName: 'temp', label: 'Temperature', width: 120, format: 'decimal1', sortable: true },
    { tagName: 'ph', label: 'pH', width: 100, format: 'decimal2', sortable: true },
    { tagName: 'do', label: 'Dissolved O2', width: 140, format: 'decimal1', sortable: false },
  ];

  it('1. renders correct number of columns', () => {
    renderWidget(DataTableRenderer, {
      config: { columns: threeColumns, pageSize: 10, showHeader: true },
    });

    // Each column header should be present
    const h0 = screen.getByTestId('header-col-0');
    const h1 = screen.getByTestId('header-col-1');
    const h2 = screen.getByTestId('header-col-2');
    expect(h0).toBeDefined();
    expect(h0.textContent).toContain('Temperature');
    expect(h1.textContent).toContain('pH');
    expect(h2.textContent).toContain('Dissolved O2');

    // Should have exactly 3 header cells
    const headers = screen.getAllByTestId(/^header-col-/);
    expect(headers).toHaveLength(3);
  });

  it('2. pagination shows correct page count', () => {
    // With pageSize=10 and 30 demo rows (isEditing generates min(pageSize*3, 100)),
    // we expect 3 pages
    renderWidget(DataTableRenderer, {
      config: { columns: threeColumns, pageSize: 10, showPagination: true },
    });

    const paginationControls = screen.getByTestId('pagination-controls');
    expect(paginationControls).toBeDefined();
    expect(paginationControls.textContent).toContain('Page 1 of 3');
  });

  it('3. renders empty state when no columns configured', () => {
    renderWidget(DataTableRenderer, {
      config: { columns: [] },
    });

    const emptyText = screen.getByText('Configure columns to display data');
    expect(emptyText).toBeDefined();
  });

  it('4. renders table rows for current page', () => {
    renderWidget(DataTableRenderer, {
      config: { columns: threeColumns, pageSize: 5, showPagination: true },
    });

    // Should render exactly pageSize rows
    const rows = screen.getAllByTestId(/^table-row-/);
    expect(rows).toHaveLength(5);
  });
});

/* ------------------------------------------------------------------ */
/*  IFrame Tests                                                       */
/* ------------------------------------------------------------------ */

describe('IFrameRenderer', () => {
  describe('URL validation', () => {
    it('5a. accepts valid https URLs', () => {
      expect(validateIFrameUrl('https://example.com')).toBeNull();
      expect(validateIFrameUrl('https://dashboard.example.com/path?q=1')).toBeNull();
    });

    it('5b. accepts http URLs (for local network cameras/PLCs)', () => {
      expect(validateIFrameUrl('http://192.168.1.100/mjpg/video.mjpg')).toBeNull();
    });

    it('5c. rejects javascript: URLs', () => {
      const result = validateIFrameUrl('javascript:alert(1)');
      expect(result).toBeTruthy();
      expect(result).toContain('Blocked protocol');
    });

    it('5d. rejects data: URLs', () => {
      const result = validateIFrameUrl('data:text/html,<h1>XSS</h1>');
      expect(result).toBeTruthy();
      expect(result).toContain('Blocked protocol');
    });

    it('5e. rejects blob: URLs', () => {
      const result = validateIFrameUrl('blob:http://example.com/uuid');
      expect(result).toBeTruthy();
      expect(result).toContain('Blocked protocol');
    });

    it('5f. rejects vbscript: URLs', () => {
      const result = validateIFrameUrl('vbscript:MsgBox("XSS")');
      expect(result).toBeTruthy();
      expect(result).toContain('Blocked protocol');
    });

    it('5g. rejects empty URLs', () => {
      expect(validateIFrameUrl('')).toBeTruthy();
      expect(validateIFrameUrl('   ')).toBeTruthy();
    });

    it('5h. rejects non-http protocols', () => {
      expect(validateIFrameUrl('ftp://files.example.com')).toBeTruthy();
      expect(validateIFrameUrl('file:///etc/passwd')).toBeTruthy();
    });
  });

  it('6. applies sandbox attribute', () => {
    renderWidget(IFrameRenderer, {
      config: {
        url: 'https://example.com',
        allowScripts: true,
        allowForms: false,
      },
      isEditing: false,
    });

    const iframe = screen.getByTestId('iframe-element');
    expect(iframe).toBeDefined();
    const sandboxAttr = iframe.getAttribute('sandbox');
    expect(sandboxAttr).toContain('allow-scripts');
    expect(sandboxAttr).not.toContain('allow-forms');
  });

  it('7. shows error state for invalid URL', () => {
    renderWidget(IFrameRenderer, {
      config: { url: 'javascript:alert(1)' },
    });

    const errorEl = screen.getByTestId('iframe-error');
    expect(errorEl).toBeDefined();
  });

  it('8. shows edit-mode preview placeholder', () => {
    renderWidget(IFrameRenderer, {
      config: { url: 'https://example.com', label: 'Dashboard' },
      isEditing: true,
    });

    const preview = screen.getByTestId('iframe-preview');
    expect(preview).toBeDefined();
    const dashboardText = screen.getByText('Dashboard');
    expect(dashboardText).toBeDefined();
  });

  it('9. renders iframe element in runtime mode', () => {
    renderWidget(IFrameRenderer, {
      config: {
        url: 'https://example.com',
        showBorder: true,
      },
      isEditing: false,
    });

    const iframe = screen.getByTestId('iframe-element');
    expect(iframe).toBeDefined();
    expect(iframe.getAttribute('src')).toBe('https://example.com');
    expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer');
  });
});

/* ------------------------------------------------------------------ */
/*  ProgressBar Tests                                                  */
/* ------------------------------------------------------------------ */

describe('ProgressBarRenderer', () => {
  it('10. renders fill at correct width percentage', () => {
    renderWidget(ProgressBarRenderer, {
      config: { min: 0, max: 100, demoValue: 75 },
    });

    const fill = screen.getByTestId('progress-fill');
    expect(fill).toBeDefined();
    // The fill div should have width: 75%
    expect(fill.style.width).toBe('75%');
  });

  it('11. applies zone colors based on value', () => {
    const zones = [
      { min: 0, max: 30, color: '#22c55e' },   // green
      { min: 30, max: 70, color: '#eab308' },   // yellow
      { min: 70, max: 100, color: '#ef4444' },   // red
    ];

    // Value at 85% should match the red zone
    renderWidget(ProgressBarRenderer, {
      config: { min: 0, max: 100, demoValue: 85, zones, fillColor: '#3b82f6' },
    });

    const fill = screen.getByTestId('progress-fill');
    expect(fill.style.backgroundColor).toBe('rgb(239, 68, 68)'); // #ef4444
  });

  it('12. uses default fill color when no zone matches', () => {
    const zones = [
      { min: 0, max: 30, color: '#22c55e' },
    ];

    // Value at 50% doesn't match any zone -- should use default fillColor
    renderWidget(ProgressBarRenderer, {
      config: { min: 0, max: 100, demoValue: 50, zones, fillColor: '#3b82f6' },
    });

    const fill = screen.getByTestId('progress-fill');
    expect(fill.style.backgroundColor).toBe('rgb(59, 130, 246)'); // #3b82f6
  });

  it('13. shows percentage label when configured', () => {
    renderWidget(ProgressBarRenderer, {
      config: {
        min: 0,
        max: 100,
        demoValue: 42,
        showLabel: true,
        showPercentage: true,
        labelPosition: 'above',
      },
    });

    const percentEl = screen.getByTestId('progress-percent');
    expect(percentEl).toBeDefined();
    expect(percentEl.textContent).toContain('42%');
  });

  it('14. shows label text', () => {
    renderWidget(ProgressBarRenderer, {
      config: {
        min: 0,
        max: 100,
        demoValue: 50,
        showLabel: true,
        labelPosition: 'below',
        label: 'Tank Fill',
      },
    });

    const labelEl = screen.getByTestId('progress-label');
    expect(labelEl).toBeDefined();
    expect(labelEl.textContent).toContain('Tank Fill');
  });

  it('15. clamps value to 0-100% range', () => {
    // Value exceeds max -- should clamp to 100%
    renderWidget(ProgressBarRenderer, {
      config: { min: 0, max: 100, demoValue: 150 },
    });

    const fill = screen.getByTestId('progress-fill');
    expect(fill.style.width).toBe('100%');
  });

  it('16. handles NaN values gracefully', () => {
    renderWidget(ProgressBarRenderer, {
      config: { min: 0, max: 100 },
      value: NaN,
      isEditing: false,
    });

    const fill = screen.getByTestId('progress-fill');
    // NaN should resolve to 0%
    expect(fill.style.width).toBe('0%');
  });
});
