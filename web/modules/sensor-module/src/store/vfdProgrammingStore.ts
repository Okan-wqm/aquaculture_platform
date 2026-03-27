/**
 * Zustand store for VFD Programming page cross-component state.
 * Manages device selection, draft change set items, UI tabs, and filters.
 */

import { create } from 'zustand';
import {
  VfdChangeSetStatus,
  VfdProgrammingParameterCategory,
} from '../types/vfd.types';

type ActiveTab = 'parameters' | 'changesets' | 'automation' | 'audit';

interface DraftItem {
  parameterName: string;
  newValue: number | string;
  originalValue: number | string;
}

interface VfdProgrammingState {
  // Selected device context
  selectedVfdDeviceId: string | null;
  selectedParameterGroup: string | null;
  selectedCategory: VfdProgrammingParameterCategory | null;

  // Change set draft state (for the parameter editor)
  draftItems: Map<string, DraftItem>;
  draftTitle: string;
  draftDescription: string;

  // UI state
  activeTab: ActiveTab;
  changeSetFilter: VfdChangeSetStatus | null;
  showAdvancedParams: boolean;
  compareMode: boolean;

  // Dialog state (backward compatibility)
  isCreateDialogOpen: boolean;
  selectedChangeSetId: string | null;

  // Actions
  setSelectedDevice: (id: string) => void;
  setSelectedGroup: (group: string | null) => void;
  setSelectedCategory: (category: VfdProgrammingParameterCategory | null) => void;
  setActiveTab: (tab: ActiveTab) => void;
  addDraftItem: (parameterName: string, newValue: number | string, originalValue: number | string) => void;
  removeDraftItem: (parameterName: string) => void;
  clearDraft: () => void;
  setDraftTitle: (title: string) => void;
  setDraftDescription: (desc: string) => void;
  toggleAdvancedParams: () => void;
  toggleCompareMode: () => void;
  setChangeSetFilter: (status: VfdChangeSetStatus | null) => void;
  openCreateDialog: () => void;
  closeCreateDialog: () => void;
  setSelectedChangeSetId: (id: string | null) => void;

  // Computed
  getDraftItemCount: () => number;
  hasDraftChanges: () => boolean;
}

export const useVfdProgrammingStore = create<VfdProgrammingState>((set, get) => ({
  // Initial state
  selectedVfdDeviceId: null,
  selectedParameterGroup: null,
  selectedCategory: null,
  draftItems: new Map(),
  draftTitle: '',
  draftDescription: '',
  activeTab: 'parameters',
  changeSetFilter: null,
  showAdvancedParams: false,
  compareMode: false,
  isCreateDialogOpen: false,
  selectedChangeSetId: null,

  // Actions
  setSelectedDevice: (id) =>
    set({
      selectedVfdDeviceId: id,
      draftItems: new Map(),
      draftTitle: '',
      draftDescription: '',
    }),

  setSelectedGroup: (group) => set({ selectedParameterGroup: group }),

  setSelectedCategory: (category) => set({ selectedCategory: category }),

  setActiveTab: (tab) => set({ activeTab: tab }),

  addDraftItem: (parameterName, newValue, originalValue) =>
    set((state) => {
      const nextItems = new Map(state.draftItems);
      nextItems.set(parameterName, { parameterName, newValue, originalValue });
      return { draftItems: nextItems };
    }),

  removeDraftItem: (parameterName) =>
    set((state) => {
      const nextItems = new Map(state.draftItems);
      nextItems.delete(parameterName);
      return { draftItems: nextItems };
    }),

  clearDraft: () =>
    set({
      draftItems: new Map(),
      draftTitle: '',
      draftDescription: '',
    }),

  setDraftTitle: (title) => set({ draftTitle: title }),

  setDraftDescription: (desc) => set({ draftDescription: desc }),

  toggleAdvancedParams: () =>
    set((state) => ({ showAdvancedParams: !state.showAdvancedParams })),

  toggleCompareMode: () =>
    set((state) => ({ compareMode: !state.compareMode })),

  setChangeSetFilter: (status) => set({ changeSetFilter: status }),

  openCreateDialog: () => set({ isCreateDialogOpen: true }),

  closeCreateDialog: () => set({ isCreateDialogOpen: false }),

  setSelectedChangeSetId: (id) => set({ selectedChangeSetId: id }),

  // Computed
  getDraftItemCount: () => get().draftItems.size,

  hasDraftChanges: () => get().draftItems.size > 0,
}));
