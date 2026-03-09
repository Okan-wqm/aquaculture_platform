/**
 * EdgeStoreContext - SCADA Builder Edge Store Abstraction
 *
 * Provides an abstract interface for edge components (OrthogonalEdge,
 * MultiHandleEdge, DraggableEdge) to persist control point / bend point
 * changes without being coupled to scadaPackageStore directly.
 *
 * The ScreenCanvas wraps its ReactFlow in this provider, bridging the
 * context value to the store's updateEdgeData action.
 */

import React, { createContext, useContext } from 'react';

export interface EdgeStoreContextValue {
  updateEdgeData: (edgeId: string, data: Record<string, unknown>) => void;
}

const EdgeStoreContext = createContext<EdgeStoreContextValue | null>(null);

export const useEdgeStoreContext = (): EdgeStoreContextValue => {
  const ctx = useContext(EdgeStoreContext);
  if (!ctx) {
    throw new Error('useEdgeStoreContext must be used within an EdgeStoreContextProvider');
  }
  return ctx;
};

export const EdgeStoreContextProvider: React.FC<{
  value: EdgeStoreContextValue;
  children: React.ReactNode;
}> = ({ value, children }) => {
  return (
    <EdgeStoreContext.Provider value={value}>
      {children}
    </EdgeStoreContext.Provider>
  );
};
