import { create } from 'zustand';
import { devtools, subscribeWithSelector } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { registerLogoutCleanup, onTenantChange } from '@aquaculture/shared-ui';
import type { ScadaStore } from './types';

import { createSceneSlice } from './sceneSlice';
import { createWidgetSlice } from './widgetSlice';
import { createEdgeSlice } from './edgeSlice';
import { createSelectionSlice } from './selectionSlice';
import { createHistorySlice } from './historySlice';
import { createAlarmSlice } from './alarmSlice';
import { createGroupSlice } from './groupSlice';
import { createTemplateSlice } from './templateSlice';
import { createProjectSlice } from './projectSlice';
import { createSimulationSlice } from './simulationSlice';
import { createOperatorSlice } from './operatorSlice';
import { createAlarmRuntimeSlice } from './alarmRuntimeSlice';
import { createNotificationSlice } from './notificationSlice';
import { createScriptSlice } from './scriptSlice';
import { createViewManagerSlice } from './viewManagerSlice';

export function createScadaStore() {
  return create<ScadaStore>()(
    devtools(
      subscribeWithSelector(
        immer((...args) => ({
          ...createSceneSlice(...args),
          ...createWidgetSlice(...args),
          ...createEdgeSlice(...args),
          ...createSelectionSlice(...args),
          ...createHistorySlice(...args),
          ...createAlarmSlice(...args),
          ...createGroupSlice(...args),
          ...createTemplateSlice(...args),
          ...createProjectSlice(...args),
          ...createSimulationSlice(...args),
          // Runtime slices (operator mode)
          ...createOperatorSlice(...args),
          ...createAlarmRuntimeSlice(...args),
          ...createNotificationSlice(...args),
          ...createScriptSlice(...args),
          ...createViewManagerSlice(...args),
        }))
      ),
      { name: 'ScadaStore', enabled: process.env.NODE_ENV === 'development' }
    )
  );
}

// Singleton instance for the application
export const useScadaPackageStore = createScadaStore();

// SECURITY (SENSOR-HIGH-041): the SCADA design store holds a single active,
// tenant-owned package (screens, alarm rules, control permissions, scripts).
// Fully reset it on logout and on any tenant switch so tenant A's in-progress
// design can never surface in — or be saved into — tenant B's session.
// onTenantChange fires only on an actual A->B change, never on first login.
// Registered against the singleton only; test-created stores stay isolated.
registerLogoutCleanup(() => useScadaPackageStore.getState().reset());
onTenantChange(() => useScadaPackageStore.getState().reset());
