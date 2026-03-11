import { create } from 'zustand';
import { devtools, subscribeWithSelector } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import type { ScadaStore } from './types';

import { createSceneSlice } from './sceneSlice';
import { createWidgetSlice } from './widgetSlice';
import { createEdgeSlice } from './edgeSlice';
import { createSelectionSlice } from './selectionSlice';
import { createHistorySlice } from './historySlice';
import { createAlarmSlice } from './alarmSlice';
import { createGroupSlice } from './groupSlice';
import { createProjectSlice } from './projectSlice';

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
          ...createProjectSlice(...args),
        }))
      ),
      { name: 'ScadaStore', enabled: process.env.NODE_ENV === 'development' }
    )
  );
}

// Singleton instance for the application
export const useScadaStore = createScadaStore();

// Backward compatibility alias
export const useScadaPackageStore = useScadaStore;
