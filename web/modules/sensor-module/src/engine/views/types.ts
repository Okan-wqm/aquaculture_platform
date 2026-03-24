export interface OverlayEntry {
  id: string;
  type: 'card' | 'dialog';
  screenId: string;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  variableMap?: Record<string, string>;
}
