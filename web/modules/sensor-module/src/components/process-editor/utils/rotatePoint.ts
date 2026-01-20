/**
 * Rotate Point Utility
 * Rotates a point (x, y) around a center point (cx, cy) by a given angle
 */

/**
 * Rotates a point around a center point
 * @param cx - Center X coordinate
 * @param cy - Center Y coordinate
 * @param x - Point X coordinate to rotate
 * @param y - Point Y coordinate to rotate
 * @param angleDeg - Rotation angle in degrees
 * @returns Rotated point coordinates
 */
export function rotatePoint(
  cx: number,
  cy: number,
  x: number,
  y: number,
  angleDeg: number
): { x: number; y: number } {
  const angleRad = (angleDeg * Math.PI) / 180;
  const dx = x - cx;
  const dy = y - cy;
  return {
    x: dx * Math.cos(angleRad) - dy * Math.sin(angleRad) + cx,
    y: dx * Math.sin(angleRad) + dy * Math.cos(angleRad) + cy,
  };
}

/**
 * Alternative function that returns left/top for CSS positioning
 */
export function rotatePointCSS(
  cx: number,
  cy: number,
  x: number,
  y: number,
  angleDeg: number
): { left: number; top: number } {
  const rotated = rotatePoint(cx, cy, x, y, angleDeg);
  return {
    left: rotated.x,
    top: rotated.y,
  };
}

export default rotatePoint;
