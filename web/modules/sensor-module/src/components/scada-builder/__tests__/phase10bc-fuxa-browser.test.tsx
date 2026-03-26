/**
 * Phase 10B+C: FUXA Export Variable Parser, Auto-Config Panel, and Widget Browser.
 *
 * Covers:
 *  1.  parseFuxaExports extracts variables from export block
 *  2.  parseFuxaExports handles _pn_, _ps_, _pb_, _pc_ prefixes
 *  3.  parseFuxaExports returns empty for SVG without export block
 *  4.  variableIdToLabel converts _pn_setState to 'Set State'
 *  5.  groupVariable assigns stateColor for _pc_state* variables
 *  6.  groupVariable assigns transform for _pn_rotateAngle
 *  7.  FuxaAutoConfigPanel renders number input for _pn_ variable
 *  8.  FuxaAutoConfigPanel renders color picker for _pc_ variable
 *  9.  FuxaAutoConfigPanel renders checkbox for _pb_ variable
 * 10.  FuxaWidgetBrowser renders category tree
 * 11.  FuxaWidgetBrowser search filters by name
 * 12.  FuxaWidgetBrowser search filters by tags
 * 13.  Catalog has entries for all major categories
 * 14.  Selected widget shows detail panel
 */

import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

/* ------------------------------------------------------------------ */
/*  Parser imports                                                     */
/* ------------------------------------------------------------------ */

import {
  parseFuxaExports,
  variableIdToLabel,
  detectVariableType,
  groupVariable,
} from '../fuxa-bridge/FuxaExportParser';

/* ------------------------------------------------------------------ */
/*  Component imports                                                  */
/* ------------------------------------------------------------------ */

import { FuxaAutoConfigPanel } from '../widget-configs/FuxaAutoConfigPanel';
import { FuxaWidgetBrowser } from '../FuxaWidgetBrowser';
import { FUXA_WIDGET_CATALOG, buildCategoryTree, getAllCategories } from '../fuxa-bridge/catalog';

/* ------------------------------------------------------------------ */
/*  Test SVG content with a realistic FUXA export block                */
/* ------------------------------------------------------------------ */

const MOCK_FUXA_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="gray"/>
  <script>
    //!export-start
    var _pc_state0 = '#00FF00';
    var _pc_state1 = '#33CC33';
    var _pc_state2 = '#FFCC00';
    var _pc_state3 = '#FF0000';
    var _pc_state4 = '#808080';
    var _pc_state5 = '#0000FF';
    var _pn_setState = 0;
    var _pn_lightShade = 15;
    var _pn_rotateAngle = 0;
    var _pb_flipHorizontal = false;
    var _ps_customLabel = 'default';
    //!export-end

    function putValue(id, value) {}
    function postValue(id, value) {}
  </script>
</svg>
`;

const SVG_WITHOUT_EXPORTS = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50">
  <circle cx="25" cy="25" r="20" fill="blue"/>
</svg>
`;

/* ================================================================== */
/*  1. parseFuxaExports extracts variables from export block           */
/* ================================================================== */

describe('parseFuxaExports', () => {
  it('extracts all variables from the export block', () => {
    const result = parseFuxaExports(MOCK_FUXA_SVG);
    expect(result.variables).toHaveLength(11);
    expect(result.raw).toContain('_pc_state0');
    expect(result.raw).toContain('_ps_customLabel');
  });

  /* ================================================================ */
  /*  2. Handles _pn_, _ps_, _pb_, _pc_ prefixes correctly            */
  /* ================================================================ */

  it('correctly detects types from prefixes', () => {
    const result = parseFuxaExports(MOCK_FUXA_SVG);
    const byId = new Map(result.variables.map((v) => [v.id, v]));

    // _pc_ = color
    expect(byId.get('_pc_state0')!.type).toBe('color');
    expect(byId.get('_pc_state0')!.defaultValue).toBe('#00FF00');

    // _pn_ = number
    expect(byId.get('_pn_setState')!.type).toBe('number');
    expect(byId.get('_pn_setState')!.defaultValue).toBe(0);

    // _pn_ = number (shade)
    expect(byId.get('_pn_lightShade')!.type).toBe('number');
    expect(byId.get('_pn_lightShade')!.defaultValue).toBe(15);

    // _pb_ = boolean
    expect(byId.get('_pb_flipHorizontal')!.type).toBe('boolean');
    expect(byId.get('_pb_flipHorizontal')!.defaultValue).toBe(false);

    // _ps_ = string
    expect(byId.get('_ps_customLabel')!.type).toBe('string');
    expect(byId.get('_ps_customLabel')!.defaultValue).toBe('default');
  });

  /* ================================================================ */
  /*  3. Returns empty for SVG without export block                    */
  /* ================================================================ */

  it('returns empty variables for SVG without export markers', () => {
    const result = parseFuxaExports(SVG_WITHOUT_EXPORTS);
    expect(result.variables).toHaveLength(0);
    expect(result.raw).toBe('');
  });

  it('returns empty for empty string', () => {
    const result = parseFuxaExports('');
    expect(result.variables).toHaveLength(0);
  });
});

/* ================================================================== */
/*  4. variableIdToLabel converts names correctly                      */
/* ================================================================== */

describe('variableIdToLabel', () => {
  it('converts _pn_setState to "Set State"', () => {
    expect(variableIdToLabel('_pn_setState')).toBe('Set State');
  });

  it('converts _pc_state0 to "State 0"', () => {
    expect(variableIdToLabel('_pc_state0')).toBe('State 0');
  });

  it('converts _pb_flipHorizontal to "Flip Horizontal"', () => {
    expect(variableIdToLabel('_pb_flipHorizontal')).toBe('Flip Horizontal');
  });

  it('converts _pn_lightShade to "Light Shade"', () => {
    expect(variableIdToLabel('_pn_lightShade')).toBe('Light Shade');
  });

  it('converts _ps_customLabel to "Custom Label"', () => {
    expect(variableIdToLabel('_ps_customLabel')).toBe('Custom Label');
  });
});

/* ================================================================== */
/*  5. groupVariable assigns stateColor for _pc_state* variables       */
/* ================================================================== */

describe('groupVariable', () => {
  it('assigns stateColor for _pc_state0', () => {
    expect(groupVariable('_pc_state0')).toBe('stateColor');
  });

  it('assigns stateColor for _pc_state5', () => {
    expect(groupVariable('_pc_state5')).toBe('stateColor');
  });

  /* ================================================================ */
  /*  6. groupVariable assigns transform for _pn_rotateAngle           */
  /* ================================================================ */

  it('assigns transform for _pn_rotateAngle', () => {
    expect(groupVariable('_pn_rotateAngle')).toBe('transform');
  });

  it('assigns transform for _pb_flipHorizontal', () => {
    expect(groupVariable('_pb_flipHorizontal')).toBe('transform');
  });

  it('assigns appearance for _pn_lightShade', () => {
    expect(groupVariable('_pn_lightShade')).toBe('appearance');
  });

  it('assigns appearance for _pn_padding', () => {
    expect(groupVariable('_pn_padding')).toBe('appearance');
  });

  it('assigns custom for unknown variable names', () => {
    expect(groupVariable('_pn_setState')).toBe('custom');
    expect(groupVariable('_ps_customLabel')).toBe('custom');
  });
});

/* ================================================================== */
/*  detectVariableType                                                 */
/* ================================================================== */

describe('detectVariableType', () => {
  it('detects number from _pn_ prefix', () => {
    expect(detectVariableType('_pn_setState')).toBe('number');
  });

  it('detects string from _ps_ prefix', () => {
    expect(detectVariableType('_ps_label')).toBe('string');
  });

  it('detects boolean from _pb_ prefix', () => {
    expect(detectVariableType('_pb_visible')).toBe('boolean');
  });

  it('detects color from _pc_ prefix', () => {
    expect(detectVariableType('_pc_state0')).toBe('color');
  });

  it('falls back to string for unknown prefix', () => {
    expect(detectVariableType('unknownVar')).toBe('string');
  });
});

/* ================================================================== */
/*  7-9. FuxaAutoConfigPanel renders correct input types               */
/* ================================================================== */

describe('FuxaAutoConfigPanel', () => {
  const parsed = parseFuxaExports(MOCK_FUXA_SVG);
  const defaultValues: Record<string, string | number | boolean> = {};
  for (const v of parsed.variables) {
    defaultValues[v.id] = v.defaultValue;
  }

  /* ================================================================ */
  /*  7. Renders number input for _pn_ variable                        */
  /* ================================================================ */

  it('renders number input for _pn_ variable', () => {
    const onChange = vi.fn();
    render(
      <FuxaAutoConfigPanel
        variables={parsed.variables}
        values={defaultValues}
        onChange={onChange}
      />,
    );

    // Find the number input for _pn_lightShade
    const input = screen.getByTestId('fuxa-field-_pn_lightShade');
    expect(input).toBeDefined();
    expect(input.getAttribute('type')).toBe('number');
  });

  /* ================================================================ */
  /*  8. Renders color picker for _pc_ variable                        */
  /* ================================================================ */

  it('renders color picker for _pc_ variable', () => {
    const onChange = vi.fn();
    render(
      <FuxaAutoConfigPanel
        variables={parsed.variables}
        values={defaultValues}
        onChange={onChange}
      />,
    );

    // Color field has both a color input and a text input
    const textInput = screen.getByTestId('fuxa-field-_pc_state0');
    expect(textInput).toBeDefined();
    // The text input should show the hex value
    expect((textInput as HTMLInputElement).value).toBe('#00FF00');
  });

  /* ================================================================ */
  /*  9. Renders checkbox for _pb_ variable                            */
  /* ================================================================ */

  it('renders checkbox for _pb_ variable', () => {
    const onChange = vi.fn();
    render(
      <FuxaAutoConfigPanel
        variables={parsed.variables}
        values={defaultValues}
        onChange={onChange}
      />,
    );

    const checkbox = screen.getByTestId('fuxa-field-_pb_flipHorizontal');
    expect(checkbox).toBeDefined();
    // The checkbox should contain a checkbox input
    const input = checkbox.querySelector('input[type="checkbox"]');
    expect(input).toBeTruthy();
  });

  it('renders empty message when no variables', () => {
    const onChange = vi.fn();
    render(
      <FuxaAutoConfigPanel
        variables={[]}
        values={{}}
        onChange={onChange}
      />,
    );

    expect(screen.getByText(/no configurable variables/i)).toBeDefined();
  });

  it('calls onChange when a number field changes', () => {
    const onChange = vi.fn();
    render(
      <FuxaAutoConfigPanel
        variables={parsed.variables}
        values={defaultValues}
        onChange={onChange}
      />,
    );

    const input = screen.getByTestId('fuxa-field-_pn_lightShade') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '25' } });
    expect(onChange).toHaveBeenCalledWith({ _pn_lightShade: 25 });
  });

  it('renders collapsible section headers', () => {
    const onChange = vi.fn();
    render(
      <FuxaAutoConfigPanel
        variables={parsed.variables}
        values={defaultValues}
        onChange={onChange}
      />,
    );

    // Should have State Colors section (stateColor group has 6 variables)
    expect(screen.getByTestId('fuxa-section-stateColor')).toBeDefined();
    // Should have Transform section
    expect(screen.getByTestId('fuxa-section-transform')).toBeDefined();
  });
});

/* ================================================================== */
/*  10-12. FuxaWidgetBrowser tests                                     */
/* ================================================================== */

describe('FuxaWidgetBrowser', () => {
  const onClose = vi.fn();
  const onSelect = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /* ================================================================ */
  /*  10. Renders category tree                                        */
  /* ================================================================ */

  it('renders category tree when open', () => {
    render(
      <FuxaWidgetBrowser open={true} onClose={onClose} onSelect={onSelect} />,
    );

    const categoryTree = screen.getByTestId('fuxa-category-tree');
    expect(categoryTree).toBeDefined();

    // Should have the main categories from the catalog.
    // Use within(categoryTree) to avoid matching text in widget cards.
    expect(within(categoryTree).getByText('All Categories')).toBeDefined();
    expect(within(categoryTree).getByText(/Process Engineering/)).toBeDefined();
    expect(within(categoryTree).getByText(/^Electrical/)).toBeDefined();
  });

  it('does not render when closed', () => {
    const { container } = render(
      <FuxaWidgetBrowser open={false} onClose={onClose} onSelect={onSelect} />,
    );

    expect(container.querySelector('[data-testid="fuxa-category-tree"]')).toBeNull();
  });

  /* ================================================================ */
  /*  11. Search filters by name                                       */
  /* ================================================================ */

  it('filters widgets by name when searching', () => {
    render(
      <FuxaWidgetBrowser open={true} onClose={onClose} onSelect={onSelect} />,
    );

    const searchInput = screen.getByTestId('fuxa-search-input') as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: 'Centrifugal' } });

    const grid = screen.getByTestId('fuxa-widget-grid');
    // Should show centrifugal pump and centrifugal compressor
    const cards = grid.querySelectorAll('[data-testid^="fuxa-widget-card-"]');
    expect(cards.length).toBeGreaterThanOrEqual(1);
    expect(cards.length).toBeLessThan(FUXA_WIDGET_CATALOG.length);

    // Verify the centrifugal pump card is present
    expect(screen.getByTestId('fuxa-widget-card-pe-pump-centrifugal')).toBeDefined();
  });

  /* ================================================================ */
  /*  12. Search filters by tags                                       */
  /* ================================================================ */

  it('filters widgets by tags when searching', () => {
    render(
      <FuxaWidgetBrowser open={true} onClose={onClose} onSelect={onSelect} />,
    );

    const searchInput = screen.getByTestId('fuxa-search-input') as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: 'valve' } });

    const grid = screen.getByTestId('fuxa-widget-grid');
    const cards = grid.querySelectorAll('[data-testid^="fuxa-widget-card-"]');
    // Should show valve entries (gate, ball, butterfly, control, check = 5)
    expect(cards.length).toBeGreaterThanOrEqual(5);
  });

  it('shows empty state for no matches', () => {
    render(
      <FuxaWidgetBrowser open={true} onClose={onClose} onSelect={onSelect} />,
    );

    const searchInput = screen.getByTestId('fuxa-search-input') as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: 'xyznonexistent123' } });

    expect(screen.getByText(/No widgets match/)).toBeDefined();
  });

  /* ================================================================ */
  /*  14. Selected widget shows detail panel                           */
  /* ================================================================ */

  it('shows detail panel when a widget is selected', () => {
    render(
      <FuxaWidgetBrowser open={true} onClose={onClose} onSelect={onSelect} />,
    );

    // Click on the centrifugal pump card
    const card = screen.getByTestId('fuxa-widget-card-pe-pump-centrifugal');
    fireEvent.click(card);

    // Detail panel should now be visible
    const detail = screen.getByTestId('fuxa-detail-panel');
    expect(detail).toBeDefined();

    // Should show widget name, description, and "Add to Canvas" button
    expect(within(detail).getByText('Centrifugal Pump')).toBeDefined();
    expect(within(detail).getByText(/6-state pump/)).toBeDefined();
    expect(screen.getByTestId('fuxa-add-to-canvas')).toBeDefined();
  });

  it('calls onSelect and onClose when "Add to Canvas" is clicked', () => {
    render(
      <FuxaWidgetBrowser open={true} onClose={onClose} onSelect={onSelect} />,
    );

    // Select a widget first
    const card = screen.getByTestId('fuxa-widget-card-pe-pump-centrifugal');
    fireEvent.click(card);

    // Click "Add to Canvas"
    const addBtn = screen.getByTestId('fuxa-add-to-canvas');
    fireEvent.click(addBtn);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pe-pump-centrifugal', name: 'Centrifugal Pump' }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape key', () => {
    render(
      <FuxaWidgetBrowser open={true} onClose={onClose} onSelect={onSelect} />,
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('filters by category when category is selected', () => {
    render(
      <FuxaWidgetBrowser open={true} onClose={onClose} onSelect={onSelect} />,
    );

    // Click on the "Basic" category button in the category tree sidebar.
    // Use getAllByText because the category name appears in both the sidebar
    // and widget cards; the sidebar button is the first match.
    const categoryTree = screen.getByTestId('fuxa-category-tree');
    const basicBtn = within(categoryTree).getByText(/^Basic/);
    fireEvent.click(basicBtn);

    const grid = screen.getByTestId('fuxa-widget-grid');
    const cards = grid.querySelectorAll('[data-testid^="fuxa-widget-card-"]');

    // Only Basic widgets should be visible
    const basicCount = FUXA_WIDGET_CATALOG.filter(
      (e) => e.category === 'Basic',
    ).length;
    expect(cards.length).toBe(basicCount);
  });
});

/* ================================================================== */
/*  13. Catalog has entries for all major categories                    */
/* ================================================================== */

describe('FUXA Widget Catalog', () => {
  it('has entries for all major categories', () => {
    const categories = getAllCategories(FUXA_WIDGET_CATALOG);

    // Must have the 4 major categories
    expect(categories).toContain('Process Engineering');
    expect(categories).toContain('Electrical');
    expect(categories).toContain('Dynamic SVG');
    expect(categories).toContain('Basic');
  });

  it('has at least 50 catalog entries', () => {
    expect(FUXA_WIDGET_CATALOG.length).toBeGreaterThanOrEqual(50);
  });

  it('builds a valid category tree', () => {
    const tree = buildCategoryTree(FUXA_WIDGET_CATALOG);
    expect(tree.length).toBeGreaterThanOrEqual(4);

    const pe = tree.find((n) => n.name === 'Process Engineering');
    expect(pe).toBeDefined();
    expect(pe!.children).toContain('Pumps');
    expect(pe!.children).toContain('Valves');
    expect(pe!.children).toContain('Tanks');
    expect(pe!.count).toBeGreaterThan(0);
  });

  it('every entry has required fields', () => {
    for (const entry of FUXA_WIDGET_CATALOG) {
      expect(entry.id).toBeTruthy();
      expect(entry.name).toBeTruthy();
      expect(entry.category).toBeTruthy();
      expect([1, 2]).toContain(entry.tier);
      expect(entry.tags.length).toBeGreaterThan(0);
      expect(entry.variableCount).toBeGreaterThan(0);
      expect(entry.description).toBeTruthy();
    }
  });

  it('has unique IDs for all entries', () => {
    const ids = FUXA_WIDGET_CATALOG.map((e) => e.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('includes Pumps subcategory with at least 5 entries', () => {
    const pumps = FUXA_WIDGET_CATALOG.filter(
      (e) => e.category === 'Process Engineering' && e.subcategory === 'Pumps',
    );
    expect(pumps.length).toBeGreaterThanOrEqual(5);
  });

  it('includes Valves subcategory with at least 5 entries', () => {
    const valves = FUXA_WIDGET_CATALOG.filter(
      (e) => e.category === 'Process Engineering' && e.subcategory === 'Valves',
    );
    expect(valves.length).toBeGreaterThanOrEqual(5);
  });
});
