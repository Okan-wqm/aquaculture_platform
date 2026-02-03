/**
 * SchedulingKeyboardContext
 * Provides keyboard navigation support for drag-drop scheduling
 *
 * Usage:
 * 1. Select shift from palette with Enter/Space
 * 2. Navigate to cell with Tab/Arrow keys
 * 3. Apply shift with Enter/Space
 * 4. Clear selection with Escape
 */

import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';

interface SelectedShift {
  shiftId: string | null;
  isOffDay: boolean;
  shiftName?: string;
}

interface SchedulingKeyboardContextValue {
  // Selected shift from palette (for keyboard-based "drop")
  selectedShift: SelectedShift | null;
  selectShift: (shift: SelectedShift) => void;
  clearSelection: () => void;

  // Focused cell tracking for arrow key navigation
  focusedCellIndex: number | null;
  setFocusedCellIndex: (index: number | null) => void;

  // Live region announcement for screen readers
  announce: (message: string) => void;

  // Mode indicator
  isKeyboardMode: boolean;
}

const SchedulingKeyboardContext = createContext<SchedulingKeyboardContextValue | null>(null);

export function SchedulingKeyboardProvider({ children }: { children: React.ReactNode }) {
  const [selectedShift, setSelectedShift] = useState<SelectedShift | null>(null);
  const [focusedCellIndex, setFocusedCellIndex] = useState<number | null>(null);
  const [isKeyboardMode, setIsKeyboardMode] = useState(false);
  const announcerRef = useRef<HTMLDivElement>(null);

  const selectShift = useCallback((shift: SelectedShift) => {
    setSelectedShift(shift);
    setIsKeyboardMode(true);

    // Announce to screen reader
    const name = shift.isOffDay ? 'Tatil' : (shift.shiftName || 'Vardiya');
    announce(`${name} secildi. Hucreye gitmek icin Tab, uygulamak icin Enter basin.`);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedShift(null);
    setFocusedCellIndex(null);
    announce('Secim temizlendi.');
  }, []);

  const announce = useCallback((message: string) => {
    if (announcerRef.current) {
      // Clear then set to trigger re-announcement
      announcerRef.current.textContent = '';
      requestAnimationFrame(() => {
        if (announcerRef.current) {
          announcerRef.current.textContent = message;
        }
      });
    }
  }, []);

  // Global Escape key handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedShift) {
        clearSelection();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedShift, clearSelection]);

  // Detect mouse usage to exit keyboard mode
  useEffect(() => {
    const handleMouseDown = () => {
      setIsKeyboardMode(false);
    };

    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, []);

  return (
    <SchedulingKeyboardContext.Provider
      value={{
        selectedShift,
        selectShift,
        clearSelection,
        focusedCellIndex,
        setFocusedCellIndex,
        announce,
        isKeyboardMode,
      }}
    >
      {children}
      {/* ARIA Live Region for announcements */}
      <div
        ref={announcerRef}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      />
    </SchedulingKeyboardContext.Provider>
  );
}

export function useSchedulingKeyboard() {
  const context = useContext(SchedulingKeyboardContext);
  if (!context) {
    throw new Error('useSchedulingKeyboard must be used within SchedulingKeyboardProvider');
  }
  return context;
}

// Optional hook for components that may or may not be within the provider
export function useOptionalSchedulingKeyboard() {
  return useContext(SchedulingKeyboardContext);
}
