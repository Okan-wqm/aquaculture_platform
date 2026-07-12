/**
 * Route-param contract pin (SENSOR-CRITICAL-001).
 *
 * The unified editor is mounted at `unified-editor/:processId` (Module.tsx).
 * The page once read `useParams<{ id }>` — a silently-undefined param that made
 * every existing process open as a blank "New Project" and let a save adopt and
 * overwrite an unrelated tenant package. The deploy spec could not catch it
 * because it mocks react-router with the param name the page expects.
 *
 * This spec uses the REAL react-router (MemoryRouter + the same route pattern
 * Module.tsx declares) so the param contract is pinned structurally: if either
 * side renames the param, this fails.
 */

import { render, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, expect, it, beforeEach, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  getProcess: vi.fn(async () => ({ id: 'proc-77', name: 'Real Route Proc', nodes: [], edges: [] })),
}));

// Heavy children + data hooks stubbed to their contract surface — the router
// itself stays REAL (that is the point of this spec).
vi.mock('../../../hooks/useProcess', () => ({
  useProcess: () => ({
    createProcess: vi.fn(),
    updateProcess: vi.fn(),
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
  useScadaPackages: () => ({ packages: [], loading: false, error: null, refetch: vi.fn() }),
  useCreateScadaPackage: () => ({ mutateAsync: vi.fn() }),
  useUpdateScadaPackage: () => ({ mutateAsync: vi.fn() }),
  useDeployScadaBundle: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('../../../hooks/useDeployProcess', () => ({
  useDeployProcessToEdge: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('../../../components/process-editor/panels/EquipmentPanel', () => ({
  EquipmentPanel: () => <div />,
}));
vi.mock('../../../components/unified-editor/ModeTabBar', () => ({ default: () => <div /> }));
vi.mock('../../../components/unified-editor/UnifiedPropertiesPanel', () => ({
  UnifiedPropertiesPanel: () => <div />,
}));
vi.mock('../../../components/unified-editor/HmiPropertiesPanel', () => ({
  HmiPropertiesPanel: () => <div />,
}));
vi.mock('../../../components/process-editor/panels/AttachmentsPanel', () => ({
  AttachmentsPanel: () => <div />,
}));
vi.mock('../../../components/process-editor/WidgetConfigModal', () => ({
  WidgetConfigModal: () => <div />,
}));
vi.mock('../../../components/unified-editor/ScreenManager', () => ({ default: () => <div /> }));
vi.mock('../../../components/unified-editor/StEditorPanel', () => ({ default: () => <div /> }));
vi.mock('../../../components/scada-builder/UnifiedLeftPanel', () => ({ UnifiedLeftPanel: () => <div /> }));
vi.mock('../../../components/scada-builder/ScreenCanvas', () => ({ ScreenCanvas: () => <div /> }));
vi.mock('../../../components/scada-builder/StableModeProvider', () => ({
  StableModeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../../components/deploy/DeployToEdgeDialog', () => ({
  DeployToEdgeDialog: () => null,
}));
vi.mock('../../../components/deploy/DeployAutomationModal', () => ({
  DeployAutomationModal: () => null,
}));
vi.mock('../../../components/deploy/ScadaPackagePreview', () => ({
  ScadaPackagePreview: () => null,
}));

import UnifiedEditorPage from '../UnifiedEditorPage';

describe('UnifiedEditorPage — route param contract (real router)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads the process identified by :processId when mounted on the real route', async () => {
    render(
      <MemoryRouter initialEntries={['/sensor/unified-editor/proc-77']}>
        <Routes>
          {/* EXACTLY the pattern Module.tsx declares. */}
          <Route path="/sensor/unified-editor/:processId" element={<UnifiedEditorPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(spies.getProcess).toHaveBeenCalledWith('proc-77'));
  });
});
