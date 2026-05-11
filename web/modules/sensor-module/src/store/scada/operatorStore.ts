/**
 * operatorStore.ts
 *
 * Standalone Zustand store for the HMI operator shell.
 * Kept separate from the design-time ScadaStore so it can be instantiated
 * independently in operator (runtime) mode without loading all editor slices.
 */

import { create } from 'zustand';
import type { StateCreator } from 'zustand';
import { devtools, subscribeWithSelector } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { createOperatorSlice } from './operatorSlice';
import type { OperatorSlice } from './operatorSlice';

export type OperatorStore = OperatorSlice;
const createStandaloneOperatorSlice = createOperatorSlice as unknown as StateCreator<
  OperatorStore,
  [['zustand/immer', never]],
  [],
  OperatorStore
>;

export const useOperatorStore = create<OperatorStore>()(
  devtools(
    subscribeWithSelector(
      immer((...args) => ({
        ...createStandaloneOperatorSlice(...args),
      })),
    ),
    { name: 'OperatorStore', enabled: process.env.NODE_ENV === 'development' },
  ),
);

export type { OperatorSlice };
