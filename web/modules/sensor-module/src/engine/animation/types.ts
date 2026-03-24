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

export type AnimationRuleType =
  | 'colorRange'
  | 'rotate'
  | 'blink'
  | 'hide'
  | 'show'
  | 'fillLevel'
  | 'move';

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
