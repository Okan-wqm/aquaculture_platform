import React, { createContext, useMemo, useEffect } from 'react';
import { TagValueBus } from './tags/TagValueBus';
import { WidgetEventBus } from './events/WidgetEventBus';
import { createNavigateHandler } from './events/handlers/NavigateHandler';
import { createOverlayHandler } from './events/handlers/OverlayHandler';
import { createTagWriteHandler } from './events/handlers/TagWriteHandler';
import { createSetPropertyHandler } from './events/handlers/SetPropertyHandler';
import { createCloseDialogHandler } from './events/handlers/CloseDialogHandler';
import { useScadaPackageStore } from '../store/scada';
import { AnimationStyles } from './animation/AnimationStyles';
import { ThemeProvider } from './theme/ThemeProvider';

export interface ScadaRuntimeContextValue {
  tagBus: TagValueBus;
  eventBus: WidgetEventBus;
}

export const ScadaRuntimeContext = createContext<ScadaRuntimeContextValue | null>(null);

export const ScadaRuntime: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const tagBus = useMemo(() => new TagValueBus(), []);
  const eventBus = useMemo(() => new WidgetEventBus(), []);

  const setActiveScreen = useScadaPackageStore((s) => s.setActiveScreen);
  const openOverlay = useScadaPackageStore((s) => s.openOverlay);
  const updateWidget = useScadaPackageStore((s) => s.updateWidget);

  // Register action handlers
  useEffect(() => {
    const unsubs: Array<() => void> = [];

    unsubs.push(eventBus.register('navigate', createNavigateHandler(setActiveScreen)));
    unsubs.push(eventBus.register('setValue', createTagWriteHandler(tagBus)));
    unsubs.push(eventBus.register('toggleValue', createTagWriteHandler(tagBus)));
    unsubs.push(eventBus.register('openCard', createOverlayHandler({ openOverlay })));
    unsubs.push(eventBus.register('openDialog', createOverlayHandler({ openOverlay })));
    unsubs.push(eventBus.register('setProperty', createSetPropertyHandler({ updateWidget })));
    unsubs.push(
      eventBus.register(
        'closeDialog',
        createCloseDialogHandler(() => useScadaPackageStore.getState()),
      ),
    );

    return () => unsubs.forEach((u) => u());
  }, [eventBus, tagBus, setActiveScreen, openOverlay, updateWidget]);

  // Bridge: simulation store tag values -> TagValueBus
  const simTagValues = useScadaPackageStore((s) => s.simTagValues);
  useEffect(() => {
    tagBus.publishBatch(simTagValues);
  }, [tagBus, simTagValues]);

  /**
   * Memory leak onlemi: Runtime unmount edildiginde tum subscription'lar temizlenir.
   * Child component'lar kendi cleanup'larini yapmasa bile bus.clear() ile
   * tum listener'lar ve cache'lenmiş degerler serbest bırakılır.
   *
   * Memory leak prevention: When the runtime unmounts, all subscriptions are cleaned up.
   * Even if child components fail to clean up after themselves, bus.clear() releases
   * all listeners and cached values.
   */
  useEffect(() => {
    return () => {
      tagBus.clear();
      eventBus.clear();
    };
  }, [tagBus, eventBus]);

  const value = useMemo(() => ({ tagBus, eventBus }), [tagBus, eventBus]);

  return (
    <ScadaRuntimeContext.Provider value={value}>
      <ThemeProvider>
        <AnimationStyles />
        {children}
      </ThemeProvider>
    </ScadaRuntimeContext.Provider>
  );
};
