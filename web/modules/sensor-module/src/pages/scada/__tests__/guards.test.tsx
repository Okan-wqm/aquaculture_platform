/**
 * Guard tests for destructive navigation actions:
 *  - ScadaBuilderToolbar Back link confirm-on-dirty (T4a)
 *  - SceneTreePanel delete confirm (T4b)
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ScadaBuilderToolbar } from '../ScadaBuilderToolbar';
import { SceneTreePanel } from '../../../components/scada-builder/SceneTreePanel';
import { createScadaStore, useScadaPackageStore } from '../../../store/scada';
import type { BuilderMode } from '../ScadaBuilderToolbar';

/* ------------------------------------------------------------------ */
/*  Toolbar helpers                                                    */
/* ------------------------------------------------------------------ */

const baseToolbarProps = {
  packageName: 'Test Package',
  onPackageNameChange: vi.fn(),
  isSaving: false,
  saveSuccess: false,
  saveError: null,
  onSave: vi.fn(),
  onModeChange: vi.fn(),
  onDeployClick: vi.fn(),
  targetDeviceId: null,
  onTargetDeviceChange: vi.fn(),
  selectedDevice: null,
  devices: [],
  onCsvDialogOpen: vi.fn(),
};

/** Route spy: renders the CURRENT location so navigation is observable. */
const LocationProbe: React.FC = () => {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
};

function renderToolbar(isDirty: boolean) {
  return render(
    <MemoryRouter initialEntries={['/builder']}>
      <LocationProbe />
      <ScadaBuilderToolbar {...baseToolbarProps} isDirty={isDirty} mode={'edit' as BuilderMode} />
    </MemoryRouter>,
  );
}

describe('ScadaBuilderToolbar Back link guard', () => {
  let confirmSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    confirmSpy = vi.spyOn(window, 'confirm');
  });
  afterEach(() => {
    confirmSpy.mockRestore();
  });

  it('asks for confirmation when dirty and BLOCKS navigation on cancel', () => {
    confirmSpy.mockReturnValue(false);
    renderToolbar(true);

    const backLink = screen.getByText('Back').closest('a')!;
    fireEvent.click(backLink);

    expect(confirmSpy).toHaveBeenCalledWith('Discard unsaved changes?');
    // Navigation was blocked: still on the builder route
    expect(screen.getByTestId('location').textContent).toBe('/builder');
  });

  it('allows navigation when the user confirms', () => {
    confirmSpy.mockReturnValue(true);
    renderToolbar(true);

    const backLink = screen.getByText('Back').closest('a')!;
    fireEvent.click(backLink);

    expect(confirmSpy).toHaveBeenCalled();
    // Link performed its client-side navigation to the package list
    expect(screen.getByTestId('location').textContent).toBe('/sensor/scada-packages');
  });

  it('does not ask when the store is clean', () => {
    confirmSpy.mockReturnValue(false);
    renderToolbar(false);

    const backLink = screen.getByText('Back').closest('a')!;
    fireEvent.click(backLink);

    expect(confirmSpy).not.toHaveBeenCalled();
    // Clean store navigates straight away
    expect(screen.getByTestId('location').textContent).toBe('/sensor/scada-packages');
  });
});

/* ------------------------------------------------------------------ */
/*  SceneTreePanel delete guard                                        */
/* ------------------------------------------------------------------ */

describe('SceneTreePanel delete guard', () => {
  // The panel reads the singleton store; seed it with two screens
  const store = createScadaStore();
  // Swap the singleton's state for an isolated test store (restore after)
  let originalState: ReturnType<typeof useScadaPackageStore.getState>;
  let confirmSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalState = useScadaPackageStore.getState();
    useScadaPackageStore.setState(store.getState(), true);
    store.getState().reset();
    store.getState().addScreen('dashboard', 'First');
    store.getState().addScreen('process', 'Second');
    useScadaPackageStore.setState(store.getState(), false);
    confirmSpy = vi.spyOn(window, 'confirm');
  });

  afterEach(() => {
    confirmSpy.mockRestore();
    useScadaPackageStore.setState(originalState, true);
  });

  function openContextMenuOn(screenName: string) {
    const row = screen.getByText(screenName);
    fireEvent.contextMenu(row);
  }

  it('does NOT delete when the user cancels the confirm', () => {
    confirmSpy.mockReturnValue(false);
    render(<SceneTreePanel />);

    openContextMenuOn('Second');
    fireEvent.click(screen.getByText('Delete'));

    expect(confirmSpy).toHaveBeenCalledWith(
      'Are you sure you want to delete this screen?',
    );
    // The delete is blocked in the store the panel acts on
    expect(store.getState().screens).toHaveLength(2);
    expect(useScadaPackageStore.getState().screens).toHaveLength(2);
  });

  it('deletes when the user confirms', () => {
    confirmSpy.mockReturnValue(true);
    render(<SceneTreePanel />);

    openContextMenuOn('Second');
    fireEvent.click(screen.getByText('Delete'));

    expect(confirmSpy).toHaveBeenCalled();
    expect(store.getState().screens).toHaveLength(1);
    expect(store.getState().screens[0].name).toBe('First');
  });
});
