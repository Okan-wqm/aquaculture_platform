import 'leaflet';
import type { Layer, LeafletEvent } from 'leaflet';

interface GeomanPathStyle {
  color?: string;
  fillColor?: string;
  fillOpacity?: number;
  weight?: number;
  dashArray?: string;
}

interface GeomanDrawOptions {
  snappable?: boolean;
  snapDistance?: number;
  allowSelfIntersection?: boolean;
  templineStyle?: GeomanPathStyle;
  hintlineStyle?: GeomanPathStyle;
  pathOptions?: GeomanPathStyle;
}

interface GeomanControlOptions {
  position?: string;
  drawMarker?: boolean;
  drawPolyline?: boolean;
  drawRectangle?: boolean;
  drawPolygon?: boolean;
  drawCircle?: boolean;
  drawCircleMarker?: boolean;
  drawText?: boolean;
  editMode?: boolean;
  dragMode?: boolean;
  cutPolygon?: boolean;
  removalMode?: boolean;
  rotateMode?: boolean;
}

interface GeomanMapApi {
  addControls(options?: GeomanControlOptions): void;
  setGlobalOptions(options: GeomanDrawOptions): void;
  enableDraw(shape: string, options?: GeomanDrawOptions): void;
  disableDraw(): void;
}

export interface GeomanCreateEvent extends LeafletEvent {
  layer: Layer;
  shape: string;
}

type GeomanCreateEventHandler = (event: GeomanCreateEvent) => void;

declare module 'leaflet' {
  interface Map {
    pm: GeomanMapApi;
    on(type: 'pm:create', fn: GeomanCreateEventHandler, context?: unknown): this;
    off(type: 'pm:create', fn?: GeomanCreateEventHandler, context?: unknown): this;
  }

  interface LeafletEventHandlerFnMap {
    'pm:create'?: GeomanCreateEventHandler | undefined;
  }
}
