/**
 * LTTB (Largest Triangle Three Buckets) downsampling algorithm
 *
 * Reduces the number of chart data points while preserving visual shape.
 * This is a display-only transformation -- original data is never mutated.
 *
 * Reference: Sveinn Steinarsson, "Downsampling Time Series for Visual
 * Representation", MSc thesis, University of Iceland, 2013.
 *
 * PERF-RISK-002: Prevents SVG DOM explosion when Recharts renders
 * 30-day / 1-min aggregate data (~43,200 points).
 */

/** Maximum data points any chart widget should render */
export const MAX_CHART_POINTS = 500;

/**
 * Downsample an array of objects using LTTB.
 *
 * @param data       The source array (will NOT be mutated)
 * @param threshold  Target number of output points (must be >= 2)
 * @param getX       Accessor for the x-axis value (numeric, e.g. timestamp ms)
 * @param getY       Accessor for the y-axis value
 * @returns A new array with at most `threshold` items, preserving first & last
 */
export function lttbDownsample<T>(
  data: T[],
  threshold: number,
  getX: (item: T) => number,
  getY: (item: T) => number,
): T[] {
  const dataLength = data.length;

  if (threshold >= dataLength || threshold < 2) {
    // Nothing to downsample -- return a shallow copy
    return data.slice();
  }

  const sampled: T[] = [];

  // Always keep first point
  sampled.push(data[0]!);

  // Bucket size (excluding first and last points)
  const bucketSize = (dataLength - 2) / (threshold - 2);

  let prevSelectedIndex = 0;

  for (let bucketIdx = 0; bucketIdx < threshold - 2; bucketIdx++) {
    // Current bucket boundaries
    const bucketStart = Math.floor(bucketIdx * bucketSize) + 1;
    const bucketEnd = Math.min(
      Math.floor((bucketIdx + 1) * bucketSize) + 1,
      dataLength - 1,
    );

    // Next bucket boundaries (for computing average point)
    const nextBucketStart = Math.floor((bucketIdx + 1) * bucketSize) + 1;
    const nextBucketEnd = Math.min(
      Math.floor((bucketIdx + 2) * bucketSize) + 1,
      dataLength - 1,
    );

    // Average point in the next bucket
    let avgX = 0;
    let avgY = 0;
    const nextBucketLen = nextBucketEnd - nextBucketStart;
    if (nextBucketLen > 0) {
      for (let j = nextBucketStart; j < nextBucketEnd; j++) {
        avgX += getX(data[j]!);
        avgY += getY(data[j]!);
      }
      avgX /= nextBucketLen;
      avgY /= nextBucketLen;
    } else {
      // Fallback: use last point
      const last = data[dataLength - 1]!;
      avgX = getX(last);
      avgY = getY(last);
    }

    // Previous selected point
    const prevX = getX(data[prevSelectedIndex]!);
    const prevY = getY(data[prevSelectedIndex]!);

    // Find the point in the current bucket that forms the largest triangle
    let maxArea = -1;
    let maxAreaIndex = bucketStart;

    for (let j = bucketStart; j < bucketEnd; j++) {
      const point = data[j]!;
      const area = Math.abs(
        (prevX - avgX) * (getY(point) - prevY) -
          (prevX - getX(point)) * (avgY - prevY),
      );

      if (area > maxArea) {
        maxArea = area;
        maxAreaIndex = j;
      }
    }

    sampled.push(data[maxAreaIndex]!);
    prevSelectedIndex = maxAreaIndex;
  }

  // Always keep last point
  sampled.push(data[dataLength - 1]!);

  return sampled;
}

/**
 * Convenience wrapper for chart data objects that have a `timestamp` field
 * and one or more numeric value fields.
 *
 * For multi-series data (after grouping), the first numeric field found
 * (excluding `timestamp`) is used as the y-axis proxy for triangle area
 * computation. This is acceptable because the downsampling goal is to
 * preserve the overall shape of the time-series curve.
 */
export function downsampleChartData<T extends Record<string, unknown>>(
  data: T[],
  maxPoints: number = MAX_CHART_POINTS,
): T[] {
  if (data.length <= maxPoints) return data;

  return lttbDownsample(
    data,
    maxPoints,
    (item) => {
      const ts = item['timestamp'];
      if (ts instanceof Date) return ts.getTime();
      if (typeof ts === 'string' || typeof ts === 'number') return new Date(ts).getTime();
      return 0;
    },
    (item) => {
      // Find first numeric value that is not the timestamp
      for (const [key, val] of Object.entries(item)) {
        if (key === 'timestamp' || key === 'time') continue;
        if (typeof val === 'number' && !Number.isNaN(val)) return val;
      }
      return 0;
    },
  );
}
