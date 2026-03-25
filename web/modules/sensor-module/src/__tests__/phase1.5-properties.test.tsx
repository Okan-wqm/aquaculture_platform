/**
 * Phase 1.5B — Per-widget permissions and general properties tests.
 *
 * Validates the GeneralPropertiesSection, WidgetPermissionsSection,
 * and the WidgetPermissions type contract introduced for ISA-101
 * role-based access control on individual SCADA widgets.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';

import { GeneralPropertiesSection } from '../components/scada-builder/widget-configs/GeneralPropertiesSection';
import { WidgetPermissionsSection } from '../components/scada-builder/widget-configs/WidgetPermissionsSection';
import type { WidgetPermissions } from '../types/scada-widget.types';

afterEach(cleanup);

/* ================================================================== */
/*  Helpers                                                            */
/* ================================================================== */

function defaultGeneralProps(overrides: Record<string, unknown> = {}) {
  return {
    widgetId: 'w-001',
    widgetType: 'gauge',
    name: 'Temp Gauge',
    x: 2,
    y: 3,
    w: 4,
    h: 2,
    locked: false,
    visible: true,
    onUpdate: vi.fn(),
    ...overrides,
  };
}

function defaultPermissions(): WidgetPermissions {
  return { showRoles: [], enableRoles: [] };
}

/* ================================================================== */
/*  GeneralPropertiesSection                                           */
/* ================================================================== */

describe('GeneralPropertiesSection', () => {
  it('renders name input with the current widget name', () => {
    const { getByTestId } = render(
      <GeneralPropertiesSection {...defaultGeneralProps()} />,
    );
    const nameInput = getByTestId('widget-name-input') as HTMLInputElement;
    expect(nameInput.value).toBe('Temp Gauge');
  });

  it('renders position X and Y inputs with correct values', () => {
    const { getByTestId } = render(
      <GeneralPropertiesSection {...defaultGeneralProps({ x: 5, y: 7 })} />,
    );
    const xInput = getByTestId('widget-x-input') as HTMLInputElement;
    const yInput = getByTestId('widget-y-input') as HTMLInputElement;
    expect(xInput.value).toBe('5');
    expect(yInput.value).toBe('7');
  });

  it('renders size W and H inputs with correct values', () => {
    const { getByTestId } = render(
      <GeneralPropertiesSection {...defaultGeneralProps({ w: 6, h: 3 })} />,
    );
    const wInput = getByTestId('widget-w-input') as HTMLInputElement;
    const hInput = getByTestId('widget-h-input') as HTMLInputElement;
    expect(wInput.value).toBe('6');
    expect(hInput.value).toBe('3');
  });

  it('calls onUpdate with locked=true when locked checkbox is toggled', () => {
    const onUpdate = vi.fn();
    const { getByTestId } = render(
      <GeneralPropertiesSection {...defaultGeneralProps({ onUpdate, locked: false })} />,
    );
    const checkbox = getByTestId('widget-locked-checkbox') as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(onUpdate).toHaveBeenCalledWith({ locked: true });
  });

  it('calls onUpdate with visible=false when visible checkbox is unchecked', () => {
    const onUpdate = vi.fn();
    const { getByTestId } = render(
      <GeneralPropertiesSection {...defaultGeneralProps({ onUpdate, visible: true })} />,
    );
    const checkbox = getByTestId('widget-visible-checkbox') as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(onUpdate).toHaveBeenCalledWith({ visible: false });
  });

  it('renders read-only type badge with humanized widget type', () => {
    const { getByTestId } = render(
      <GeneralPropertiesSection {...defaultGeneralProps({ widgetType: 'trendChart' })} />,
    );
    const badge = getByTestId('widget-type-badge');
    expect(badge.textContent).toBe('trend Chart');
  });

  it('dispatches position update when X input changes', () => {
    const onUpdate = vi.fn();
    const { getByTestId } = render(
      <GeneralPropertiesSection {...defaultGeneralProps({ onUpdate, x: 2, y: 3, w: 4, h: 2 })} />,
    );
    const xInput = getByTestId('widget-x-input');
    fireEvent.change(xInput, { target: { value: '10' } });
    expect(onUpdate).toHaveBeenCalledWith({
      position: { col: 10, row: 3, w: 4, h: 2 },
    });
  });

  it('dispatches size update when W input changes', () => {
    const onUpdate = vi.fn();
    const { getByTestId } = render(
      <GeneralPropertiesSection {...defaultGeneralProps({ onUpdate, x: 2, y: 3, w: 4, h: 2 })} />,
    );
    const wInput = getByTestId('widget-w-input');
    fireEvent.change(wInput, { target: { value: '8' } });
    expect(onUpdate).toHaveBeenCalledWith({
      position: { col: 2, row: 3, w: 8, h: 2 },
    });
  });
});

/* ================================================================== */
/*  WidgetPermissionsSection                                           */
/* ================================================================== */

describe('WidgetPermissionsSection', () => {
  it('renders collapsed by default', () => {
    const { getByTestId, queryByTestId } = render(
      <WidgetPermissionsSection
        permissions={defaultPermissions()}
        onChange={vi.fn()}
      />,
    );
    // Toggle button should exist
    expect(getByTestId('permissions-toggle')).toBeTruthy();
    // Content should NOT be rendered
    expect(queryByTestId('permissions-content')).toBeNull();
  });

  it('expands on click to show role checkboxes', () => {
    const { getByTestId, queryByTestId } = render(
      <WidgetPermissionsSection
        permissions={defaultPermissions()}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(getByTestId('permissions-toggle'));
    expect(queryByTestId('permissions-content')).toBeTruthy();
  });

  it('shows all four role checkboxes when expanded', () => {
    const { getByTestId } = render(
      <WidgetPermissionsSection
        permissions={defaultPermissions()}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(getByTestId('permissions-toggle'));
    // showRoles checkboxes
    expect(getByTestId('show-role-admin')).toBeTruthy();
    expect(getByTestId('show-role-supervisor')).toBeTruthy();
    expect(getByTestId('show-role-operator')).toBeTruthy();
    expect(getByTestId('show-role-viewer')).toBeTruthy();
    // enableRoles checkboxes
    expect(getByTestId('enable-role-admin')).toBeTruthy();
    expect(getByTestId('enable-role-supervisor')).toBeTruthy();
    expect(getByTestId('enable-role-operator')).toBeTruthy();
    expect(getByTestId('enable-role-viewer')).toBeTruthy();
  });

  it('empty roles means "visible/enabled for all" — shows hint text', () => {
    const { getByTestId, getByText } = render(
      <WidgetPermissionsSection
        permissions={defaultPermissions()}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(getByTestId('permissions-toggle'));
    expect(getByText('Visible to all roles')).toBeTruthy();
    expect(getByText('Enabled for all roles')).toBeTruthy();
  });

  it('toggling a show role calls onChange with the role added', () => {
    const onChange = vi.fn();
    const { getByTestId } = render(
      <WidgetPermissionsSection
        permissions={defaultPermissions()}
        onChange={onChange}
      />,
    );
    fireEvent.click(getByTestId('permissions-toggle'));
    fireEvent.click(getByTestId('show-role-operator'));
    expect(onChange).toHaveBeenCalledWith({
      showRoles: ['operator'],
      enableRoles: [],
    });
  });

  it('toggling an already-selected role removes it', () => {
    const onChange = vi.fn();
    const { getByTestId } = render(
      <WidgetPermissionsSection
        permissions={{ showRoles: ['admin', 'operator'], enableRoles: [] }}
        onChange={onChange}
      />,
    );
    fireEvent.click(getByTestId('permissions-toggle'));
    fireEvent.click(getByTestId('show-role-admin'));
    expect(onChange).toHaveBeenCalledWith({
      showRoles: ['operator'],
      enableRoles: [],
    });
  });

  it('reset button clears all restrictions', () => {
    const onChange = vi.fn();
    const { getByTestId } = render(
      <WidgetPermissionsSection
        permissions={{ showRoles: ['admin'], enableRoles: ['supervisor'] }}
        onChange={onChange}
      />,
    );
    fireEvent.click(getByTestId('permissions-toggle'));
    fireEvent.click(getByTestId('permissions-reset'));
    expect(onChange).toHaveBeenCalledWith({
      showRoles: [],
      enableRoles: [],
    });
  });
});

/* ================================================================== */
/*  WidgetPermissions Type Contract                                    */
/* ================================================================== */

describe('WidgetPermissions type', () => {
  it('has correct fields with string array types', () => {
    // Compile-time type check enforced by TypeScript.
    // Runtime sanity: ensure a valid WidgetPermissions object
    // matches the expected shape.
    const perms: WidgetPermissions = {
      showRoles: ['admin', 'operator'],
      enableRoles: ['supervisor'],
    };
    expect(Array.isArray(perms.showRoles)).toBe(true);
    expect(Array.isArray(perms.enableRoles)).toBe(true);
    expect(perms.showRoles).toEqual(['admin', 'operator']);
    expect(perms.enableRoles).toEqual(['supervisor']);
  });
});
