/**
 * 6b — UnifiedEditorPage consolidation.
 *
 * Pins the three behaviours the unified shell gained in sub-PR 6b:
 *   (a) HMI mode mounts the REAL <ScreenCanvas> (Layer-B data plane) while the
 *       P&ID iframe stays mounted but hidden — mode switches never destroy the
 *       P&ID diagram, and HMI is no longer the fake iframe-overlay.
 *   (b) The Deploy menu binds BOTH artifacts to the canonical DeployToEdgeDialog,
 *       each wired to its own mutation (process → useDeployProcessToEdge,
 *       SCADA → useDeployScadaPackage).
 *   (c) Save persists BOTH artifacts (dual-target save): the P&ID process AND
 *       the linked SCADA package.
 *
 * Heavy visual children (ReactFlow canvas, palettes, the real deploy dialog)
 * are stubbed to their contract surface so the test asserts wiring, not paint.
 */

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';

import { useEditorModeStore } from '../../../store/editorModeStore';
import { useProcessStore } from '../../../store/processStore';
import { useScadaPackageStore } from '../../../store/scada';

// --- hoisted spies shared between the vi.mock factories and the assertions ---
const spies = vi.hoisted(() => ({
  deployProcess: vi.fn(async () => ({ success: true })),
  deployScada: vi.fn(async () => ({ success: true, packageId: 'pkg-1', deviceId: 'device-1' })),
  createPkg: vi.fn(async () => ({ id: 'new-pkg' })),
  updatePkg: vi.fn(async () => ({ id: 'pkg-1' })),
  createProcess: vi.fn(async () => ({ success: true, process: { id: 'proc-1' } })),
  updateProcess: vi.fn(async () => ({ success: true })),
  getProcess: vi.fn(async () => ({ id: 'proc-1', name: 'Test Proc', nodes: [], edges: [] })),
  linkedPackages: [] as Array<{ id: string; packageData: unknown }>,
}));

vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'proc-1' }),
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

vi.mock('../../../hooks/useProcess', () => ({
  useProcess: () => ({
    createProcess: spies.createProcess,
    updateProcess: spies.updateProcess,
    getProcess: spies.getProcess,
  }),
}));

vi.mock('../../../hooks/useEdgeDevices', () => ({
  useEdgeDevices: () => ({ data: { items: [] } }),
  formatLastSeen: () => 'now',
}));

vi.mock('../../../hooks/useUnifiedTags', () => ({
  useUnifiedTags: () => ({ tags: [], loading: false, error: null, refetch: vi.fn() }),
}));

vi.mock('../../../hooks/useScadaPackage', () => ({
  useScadaPackages: () => ({ packages: spies.linkedPackages, loading: false, error: null, refetch: vi.fn() }),
  useCreateScadaPackage: () => ({ mutateAsync: spies.createPkg }),
  useUpdateScadaPackage: () => ({ mutateAsync: spies.updatePkg }),
  useDeployScadaPackage: () => ({ mutateAsync: spies.deployScada }),
}));

vi.mock('../../../hooks/useDeployProcess', () => ({
  useDeployProcessToEdge: () => ({ mutateAsync: spies.deployProcess }),
}));

// Stub heavy visual children down to their contract surface.
vi.mock('../../../components/process-editor/panels/EquipmentPanel', () => ({
  EquipmentPanel: () => <div data-testid="equipment-panel" />,
}));
vi.mock('../../../components/unified-editor/ModeTabBar', () => ({
  default: () => <div data-testid="mode-tab-bar" />,
}));
vi.mock('../../../components/unified-editor/UnifiedPropertiesPanel', () => ({
  UnifiedPropertiesPanel: () => <div data-testid="properties-panel" />,
}));
vi.mock('../../../components/unified-editor/ScreenManager', () => ({
  default: () => <div data-testid="screen-manager" />,
}));
vi.mock('../../../components/unified-editor/StEditorPanel', () => ({
  default: () => <div data-testid="st-editor" />,
}));
vi.mock('../../../components/scada-builder/WidgetPalette', () => ({
  WidgetPalette: () => <div data-testid="widget-palette" />,
}));
vi.mock('../../../components/scada-builder/ScreenCanvas', () => ({
  ScreenCanvas: ({ isPreview }: { isPreview?: boolean }) => (
    <div data-testid="screen-canvas" data-preview={String(!!isPreview)} />
  ),
}));
vi.mock('../../../components/scada-builder/StableModeProvider', () => ({
  StableModeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../../components/deploy/ScadaPackagePreview', () => ({
  ScadaPackagePreview: () => <div data-testid="scada-preview" />,
}));

// Stub the deploy dialog: expose title/accent + a confirm button that drives
// onDeploy and renders its result so wiring + guards can be asserted directly.
vi.mock('../../../components/deploy/DeployToEdgeDialog', () => ({
  DeployToEdgeDialog: ({
    title,
    artifactName,
    accent,
    preview,
    isOpen,
    onDeploy,
  }: {
    title: string;
    artifactName: string;
    accent?: string;
    preview?: React.ReactNode;
    isOpen: boolean;
    onClose: () => void;
    onDeploy: (deviceId: string) => Promise<{ success: boolean; message?: string }>;
  }) => {
    const [result, setResult] = React.useState<string>('');
    if (!isOpen) return null;
    return (
      <div data-testid={`deploy-dialog-${accent}`}>
        <span data-testid="deploy-title">{title}</span>
        <span data-testid="deploy-artifact">{artifactName}</span>
        {preview}
        <button
          data-testid={`deploy-confirm-${accent}`}
          onClick={async () => {
            const r = await onDeploy('device-1');
            setResult(r.success ? 'ok' : r.message || 'fail');
          }}
        >
          confirm
        </button>
        <span data-testid={`deploy-result-${accent}`}>{result}</span>
      </div>
    );
  },
}));

import UnifiedEditorPage from '../UnifiedEditorPage';

function resetStores(): void {
  useEditorModeStore.setState({ mode: 'pid', isCanvasEditable: true });
  useProcessStore.getState().resetStore();
  useScadaPackageStore.getState().loadFromJSON({ screens: [{ id: 's1', name: 'Main', isDefault: true }] });
  useScadaPackageStore.getState().setPackageId(null);
}

/** Fire the iframe "ready" handshake so isCanvasReady flips true (enables Save). */
function fireCanvasReady(): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: 'ready', source: 'process-editor-canvas', data: undefined },
      }),
    );
  });
}

describe('UnifiedEditorPage — 6b consolidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spies.linkedPackages = [];
    resetStores();
  });

  it('(a) HMI mode mounts the real ScreenCanvas and hides the P&ID iframe', async () => {
    render(<UnifiedEditorPage />);
    // P&ID default: iframe visible, no ScreenCanvas.
    const iframe = screen.getByTitle('Process Editor Canvas');
    expect(iframe.className).not.toContain('hidden');
    expect(screen.queryByTestId('screen-canvas')).toBeNull();

    // Switch to HMI: real ScreenCanvas mounts (edit, not preview), iframe hidden.
    act(() => useEditorModeStore.getState().setMode('hmi'));
    await waitFor(() => expect(screen.getByTestId('screen-canvas')).toBeTruthy());
    expect(screen.getByTestId('screen-canvas').getAttribute('data-preview')).toBe('false');
    expect(screen.getByTitle('Process Editor Canvas').className).toContain('hidden');
  });

  it('(b) Deploy menu wires the process path to useDeployProcessToEdge (cyan)', async () => {
    render(<UnifiedEditorPage />);
    await waitFor(() => expect(spies.getProcess).toHaveBeenCalled());

    fireEvent.click(screen.getByText('Deploy'));
    fireEvent.click(screen.getByText(/Proses/));

    const dialog = await screen.findByTestId('deploy-dialog-cyan');
    expect(dialog).toBeTruthy();
    expect(screen.getByTestId('deploy-title').textContent).toContain('Proses');

    fireEvent.click(screen.getByTestId('deploy-confirm-cyan'));
    await waitFor(() =>
      expect(spies.deployProcess).toHaveBeenCalledWith({ processId: 'proc-1', deviceId: 'device-1' }),
    );
    expect(spies.deployScada).not.toHaveBeenCalled();
  });

  it('(b) Deploy menu wires the SCADA path to useDeployScadaPackage (purple)', async () => {
    spies.linkedPackages = [
      { id: 'pkg-1', packageData: { meta: { schemaVersion: 2, packageName: 'HMI' }, screens: [{ id: 's1', name: 'Main', isDefault: true }] } },
    ];
    render(<UnifiedEditorPage />);
    // Hydration effect adopts the linked package id.
    await waitFor(() => expect(spies.getProcess).toHaveBeenCalled());

    fireEvent.click(screen.getByText('Deploy'));
    fireEvent.click(screen.getByText(/SCADA Paketi/));

    await screen.findByTestId('deploy-dialog-purple');
    expect(screen.getByTestId('scada-preview')).toBeTruthy();

    fireEvent.click(screen.getByTestId('deploy-confirm-purple'));
    await waitFor(() =>
      expect(spies.deployScada).toHaveBeenCalledWith({ packageId: 'pkg-1', deviceId: 'device-1' }),
    );
  });

  it('(b) SCADA deploy is blocked with a message when no package is saved yet', async () => {
    spies.linkedPackages = [];
    render(<UnifiedEditorPage />);
    await waitFor(() => expect(spies.getProcess).toHaveBeenCalled());

    fireEvent.click(screen.getByText('Deploy'));
    fireEvent.click(screen.getByText(/SCADA Paketi/));
    await screen.findByTestId('deploy-dialog-purple');
    fireEvent.click(screen.getByTestId('deploy-confirm-purple'));

    await waitFor(() =>
      expect(screen.getByTestId('deploy-result-purple').textContent).toMatch(/kaydedin/),
    );
    expect(spies.deployScada).not.toHaveBeenCalled();
  });

  it('(c) Save persists BOTH the process and the SCADA package (dual-target)', async () => {
    render(<UnifiedEditorPage />);
    await waitFor(() => expect(spies.getProcess).toHaveBeenCalled());
    fireCanvasReady();

    // Save is enabled once the canvas is ready and the doc is dirty (load set the name).
    const saveBtn = await screen.findByText('Save');
    await waitFor(() => expect((saveBtn.closest('button') as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(saveBtn);
    // handleSave requests canvas state; answer immediately so it doesn't wait out
    // the 2s fallback timeout.
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          data: { type: 'state', source: 'process-editor-canvas', data: { nodes: [], edges: [] } },
        }),
      );
    });

    // Existing process (getProcess returned proc-1) → update; no linked package → create.
    await waitFor(() => expect(spies.updateProcess).toHaveBeenCalled());
    await waitFor(() => expect(spies.createPkg).toHaveBeenCalled());
    const createArg = spies.createPkg.mock.calls[0][0] as { processId: string };
    expect(createArg.processId).toBe('proc-1');
  });
});
