/** Color range: when tag value is between min and max, apply these colors */
export interface ColorRange {
  min: number;
  max: number;
  fill: string;
  stroke?: string;
  label?: string;
}

/** Tag-driven animation rule — evaluated on every tag value change */
export interface AnimationRule {
  id: string;
  tagName: string;
  bitmask?: number;
  range: { min: number; max: number };
  type: AnimationRuleType;
  options: AnimationOptions;
}

/**
 * Animation rule types for SCADA widget visual transformations.
 * Each type maps a tag value to a specific visual behavior.
 * The first 7 are the original set; the last 5 provide FUXA feature parity
 * for industrial SCADA dashboards (valve indicators, pumps, pipe flow, etc.).
 */
export type AnimationRuleType =
  | 'colorRange'
  | 'rotate'
  | 'blink'
  | 'hide'
  | 'show'
  | 'fillLevel'
  | 'move'
  | 'valueMappedRotation'  // maps tag value range to a static angle range
  | 'piston'               // vertical oscillation for pump/compressor symbols
  | 'imageAlongPath'       // image travels along an SVG motion path
  | 'recursiveColor'       // applies color to all SVG children via CSS custom properties
  | 'scale';               // maps tag value range to a scale factor range

export interface AnimationOptions {
  // colorRange
  ranges?: ColorRange[];
  // rotate
  rotationSpeed?: number;       // ms per revolution (default 2000)
  direction?: 'cw' | 'ccw';
  // blink
  blinkInterval?: number;       // ms (default 1000)
  fillA?: string;
  fillB?: string;
  strokeA?: string;
  strokeB?: string;
  // fillLevel
  fillMin?: number;
  fillMax?: number;
  fillColor?: string;
  fillWarningThreshold?: number;
  fillCriticalThreshold?: number;
  fillWarningColor?: string;
  fillCriticalColor?: string;
  // move
  toX?: number;
  toY?: number;
  duration?: number;

  /** valueMappedRotation: angle produced when tag equals range minimum */
  minAngle?: number;
  /** valueMappedRotation: angle produced when tag equals range maximum */
  maxAngle?: number;

  /** piston: vertical oscillation distance in pixels (default 20) */
  pistonDistance?: number;
  /** piston: oscillation cycle duration in milliseconds (default 1000) */
  pistonDuration?: number;

  /** imageAlongPath: SVG path data string (`d` attribute) for the motion path */
  motionPath?: string;
  /** imageAlongPath: duration of one full path traversal in milliseconds (default 3000) */
  motionDuration?: number;

  /** recursiveColor: CSS custom property name to set (e.g. '--scada-fill') */
  colorVariable?: string;

  /** scale: scale factor produced when tag equals range minimum (default 0.5) */
  minScale?: number;
  /** scale: scale factor produced when tag equals range maximum (default 2.0) */
  maxScale?: number;
}

/** Output of AnimationEngine.evaluate() — consumed by renderers */
export interface AnimationState {
  visible: boolean;
  fill?: string;
  stroke?: string;
  rotating: boolean;
  rotationSpeed: number;
  rotationDirection: 'cw' | 'ccw';
  blinking: boolean;
  blinkInterval: number;
  blinkFillA?: string;
  blinkFillB?: string;
  blinkStrokeA?: string;
  blinkStrokeB?: string;
  fillPercent?: number;
  fillColor?: string;
  translateX: number;
  translateY: number;
  transitionDuration: number;

  /** Computed static rotation angle from valueMappedRotation rule */
  mappedRotation?: number;

  /** Piston oscillation active flag */
  pistoning?: boolean;
  /** Piston vertical oscillation distance in pixels */
  pistonDistance?: number;
  /** Piston oscillation cycle duration in milliseconds */
  pistonDuration?: number;

  /** SVG motion path data for imageAlongPath */
  motionPath?: string;
  /** Duration of one full path traversal in milliseconds */
  motionDuration?: number;
  /** Whether the image-along-path animation is active */
  motionActive?: boolean;

  /** CSS custom property overrides for recursiveColor — cascaded to all SVG children */
  cssVariables?: Record<string, string>;

  /** Computed scale factor from scale rule */
  mappedScale?: number;
}

export const DEFAULT_ANIMATION_STATE: AnimationState = {
  visible: true,
  rotating: false,
  rotationSpeed: 2000,
  rotationDirection: 'cw',
  blinking: false,
  blinkInterval: 1000,
  fillPercent: undefined,
  translateX: 0,
  translateY: 0,
  transitionDuration: 0,
};
