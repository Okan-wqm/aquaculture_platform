/**
 * Deffeyes Diagram Chart Component
 *
 * Full-featured Deffeyes (ALK vs DIC) diagram with:
 * - pH isolines (4.25 - 12.50)
 * - NH3 toxic zone (red filled wedge via Area, between NH3 line and Y-axis)
 * - CO2 toxic zone (red filled area via Area, between CO2 curve and X-axis)
 * - Safe operating zone (green)
 * - Current operating point (blue star)
 * - Target point (black X with dashed line)
 * - Reagent direction line (optional)
 * - Visibility toggles for each layer
 */
import type { DeffeyesChartData, DosingVisualization, OnDemandStep, SafeZone } from '@platform/aquaculture-engines';
import React, { useMemo, useState } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Customized,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

interface DeffeyesChartProps {
  data: DeffeyesChartData;
  maxDIC?: number;
  maxALK?: number;
  onDemandPath?: OnDemandStep[];
  /**
   * When true, force the safety overlays (NH₃/CO₂/H₂S toxic zones + safe zone)
   * visible regardless of the user's per-layer toggles. Used for the printed
   * report so the exported chart always shows the toxicity bands.
   */
  forceSafetyOverlays?: boolean;
}

type AlkDicPoint = { CT: number; AT: number };

interface ScatterShapeProps {
  cx?: number;
  cy?: number;
  payload?: {
    angle?: number;
  };
}

interface AxisScale {
  scale?: (value: number) => number;
}

interface CustomizedLayerProps {
  xAxisMap?: Record<string, AxisScale>;
  yAxisMap?: Record<string, AxisScale>;
}

type PHIsoline = DeffeyesChartData['isolines'][number];

function getChartScales(props: CustomizedLayerProps): {
  xScale: (value: number) => number;
  yScale: (value: number) => number;
} | null {
  const xAxis = props.xAxisMap ? Object.values(props.xAxisMap)[0] : undefined;
  const yAxis = props.yAxisMap ? Object.values(props.yAxisMap)[0] : undefined;
  if (!xAxis?.scale || !yAxis?.scale) return null;
  return { xScale: xAxis.scale, yScale: yAxis.scale };
}

/** Select subset of isolines for display - show every 0.5 pH */
function selectDisplayIsolines(data: DeffeyesChartData): {
  major: DeffeyesChartData['isolines'];
  minor: DeffeyesChartData['isolines'];
} {
  const majorPHs = new Set<number>();
  for (let pH = 5.0; pH <= 12.0; pH += 0.5) {
    majorPHs.add(parseFloat(pH.toFixed(2)));
  }
  return {
    major: data.isolines.filter(iso => majorPHs.has(iso.pH)),
    minor: data.isolines.filter(iso => !majorPHs.has(iso.pH)),
  };
}

/** Interpolate CT where AT crosses a target value between two points */
function interpolateCT(
  p1: { CT: number; AT: number },
  p2: { CT: number; AT: number },
  targetAT: number
): number {
  if (Math.abs(p2.AT - p1.AT) < 1e-10) return p1.CT;
  const t = (targetAT - p1.AT) / (p2.AT - p1.AT);
  return p1.CT + t * (p2.CT - p1.CT);
}

/** Interpolate AT where CT crosses a target value between two points */
function interpolateAT(
  p1: { CT: number; AT: number },
  p2: { CT: number; AT: number },
  targetCT: number
): number {
  if (Math.abs(p2.CT - p1.CT) < 1e-10) return p1.AT;
  const t = (targetCT - p1.CT) / (p2.CT - p1.CT);
  return p1.AT + t * (p2.AT - p1.AT);
}

/**
 * Clip CO2 boundary to visible chart area [0,maxDIC] x [0,maxALK].
 * Extends to chart edges so the filled area reaches all boundaries.
 * Area with baseValue=0 fills between curve and x-axis.
 */
function clipCO2Boundary(
  rawPoints: AlkDicPoint[],
  maxDIC: number,
  maxALK: number
): AlkDicPoint[] {
  const result: AlkDicPoint[] = [];

  for (let i = 0; i < rawPoints.length; i++) {
    const curr = rawPoints[i];
    const prev = i > 0 ? rawPoints[i - 1] : null;

    // Interpolate AT=0 crossing (curve enters visible area from below)
    if (prev && prev.AT < 0 && curr.AT >= 0) {
      const crossCT = interpolateCT(prev, curr, 0);
      if (crossCT >= 0 && crossCT <= maxDIC) {
        result.push({ CT: parseFloat(crossCT.toFixed(4)), AT: 0 });
      }
    }

    // Interpolate CT=0 crossing (curve enters from left)
    if (prev && prev.CT < 0 && curr.CT >= 0 && curr.AT >= 0) {
      const crossAT = interpolateAT(prev, curr, 0);
      if (crossAT >= 0 && crossAT <= maxALK) {
        result.push({ CT: 0, AT: parseFloat(Math.min(crossAT, maxALK).toFixed(4)) });
      }
    }

    // Include if fully in visible range
    if (curr.CT >= 0 && curr.CT <= maxDIC && curr.AT >= 0 && isFinite(curr.AT)) {
      result.push({ CT: curr.CT, AT: Math.min(curr.AT, maxALK) });
    }

    // Interpolate to CT=maxDIC boundary (curve exits through right edge)
    if (prev && prev.CT <= maxDIC && curr.CT > maxDIC) {
      const atAtMax = interpolateAT(prev, curr, maxDIC);
      if (isFinite(atAtMax) && atAtMax >= 0) {
        result.push({ CT: maxDIC, AT: Math.min(atAtMax, maxALK) });
      }
      break;
    }
  }

  return result;
}

/**
 * Clip NH3 boundary to visible chart area [0,maxDIC] x [0,maxALK].
 * Extends to chart edges so the filled area reaches all boundaries.
 * Area with baseValue=maxALK fills between line and top edge.
 */
function clipNH3Boundary(
  rawPoints: AlkDicPoint[],
  maxDIC: number,
  maxALK: number
): AlkDicPoint[] {
  const result: AlkDicPoint[] = [];

  for (let i = 0; i < rawPoints.length; i++) {
    const curr = rawPoints[i];
    const prev = i > 0 ? rawPoints[i - 1] : null;

    // Interpolate AT=0 crossing (line enters visible area from below)
    if (prev && prev.AT < 0 && curr.AT >= 0 && curr.CT >= 0 && curr.CT <= maxDIC) {
      const crossCT = interpolateCT(prev, curr, 0);
      if (crossCT >= 0 && crossCT <= maxDIC) {
        result.push({ CT: parseFloat(crossCT.toFixed(4)), AT: 0 });
      }
    }

    // Include if in visible range
    if (curr.CT >= 0 && curr.CT <= maxDIC && curr.AT >= 0 && curr.AT <= maxALK) {
      result.push(curr);
    }

    // Interpolate AT=maxALK crossing (line exits through top)
    if (prev && prev.AT <= maxALK && curr.AT > maxALK && prev.CT >= 0) {
      const crossCT = interpolateCT(prev, curr, maxALK);
      if (crossCT >= 0 && crossCT <= maxDIC) {
        result.push({ CT: parseFloat(crossCT.toFixed(4)), AT: maxALK });
      }
      return result; // Done - exited through top
    }

    // Interpolate CT=maxDIC crossing (line exits through right edge)
    if (prev && prev.CT <= maxDIC && curr.CT > maxDIC) {
      const atAtMax = interpolateAT(prev, curr, maxDIC);
      if (isFinite(atAtMax) && atAtMax >= 0) {
        result.push({ CT: maxDIC, AT: Math.min(atAtMax, maxALK) });
      }
      return result; // Done - exited through right
    }
  }

  // If we get here, the line stayed within bounds for all points.
  // Add final point at CT=maxDIC if last point didn't reach it.
  if (result.length > 0) {
    const last = result[result.length - 1];
    if (last.CT < maxDIC - 0.01) {
      // Extrapolate from last two points
      if (result.length >= 2) {
        const prev2 = result[result.length - 2];
        const extAT = interpolateAT(prev2, last, maxDIC);
        if (isFinite(extAT) && extAT >= 0 && extAT <= maxALK) {
          result.push({ CT: maxDIC, AT: extAT });
        }
      }
    }
  }

  return result;
}

/** Custom shape for current operating point (blue star) */
const StarShape: React.FC<ScatterShapeProps> = (props) => {
  const { cx, cy } = props;
  if (cx == null || cy == null) return null;
  const r = 8;
  const points: string[] = [];
  for (let i = 0; i < 5; i++) {
    const angle = (i * 72 - 90) * Math.PI / 180;
    points.push(`${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`);
    const innerAngle = ((i * 72 + 36) - 90) * Math.PI / 180;
    points.push(`${cx + r * 0.4 * Math.cos(innerAngle)},${cy + r * 0.4 * Math.sin(innerAngle)}`);
  }
  return <polygon points={points.join(' ')} fill="#2563eb" stroke="#1d4ed8" strokeWidth={1} />;
};

/** Custom arrowhead shape for reagent direction line tip */
const ArrowShape: React.FC<ScatterShapeProps> = (props) => {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null) return null;
  const angle = payload?.angle ?? 0;
  const size = 12;
  // Arrow pointing in the direction given by angle (SVG coords)
  const tipX = cx;
  const tipY = cy;
  const a1 = angle + Math.PI * 0.82;
  const a2 = angle - Math.PI * 0.82;
  return (
    <polygon
      points={`${tipX},${tipY} ${tipX + size * Math.cos(a1)},${tipY + size * Math.sin(a1)} ${tipX + size * Math.cos(a2)},${tipY + size * Math.sin(a2)}`}
      fill="#f59e0b"
      stroke="#d97706"
      strokeWidth={1}
    />
  );
};

/** Custom shape for target point (black X) */
const CrossShape: React.FC<ScatterShapeProps> = (props) => {
  const { cx, cy } = props;
  if (cx == null || cy == null) return null;
  const s = 7;
  return (
    <g>
      <line x1={cx - s} y1={cy - s} x2={cx + s} y2={cy + s} stroke="#111827" strokeWidth={2.5} />
      <line x1={cx + s} y1={cy - s} x2={cx - s} y2={cy + s} stroke="#111827" strokeWidth={2.5} />
    </g>
  );
};

/** Custom shape for intermediate dosing point (orange diamond) */
const DiamondShape: React.FC<ScatterShapeProps> = (props) => {
  const { cx, cy } = props;
  if (cx == null || cy == null) return null;
  const s = 7;
  return (
    <polygon
      points={`${cx},${cy - s} ${cx + s},${cy} ${cx},${cy + s} ${cx - s},${cy}`}
      fill="#f59e0b"
      stroke="#d97706"
      strokeWidth={1.5}
    />
  );
};

/** Layer visibility checkbox */
const LayerToggle: React.FC<{
  label: string;
  color: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}> = ({ label, color, checked, onChange }) => (
  <label className="flex items-center gap-1.5 cursor-pointer select-none text-xs text-gray-700">
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className="w-3.5 h-3.5 rounded border-gray-300 cursor-pointer"
      style={{ accentColor: color }}
    />
    <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: color, opacity: 0.7 }} />
    {label}
  </label>
);

function createSafeZoneLayer(safeZone: SafeZone): React.FC<CustomizedLayerProps> {
  return function SafeZoneLayer(props: CustomizedLayerProps) {
    const scales = getChartScales(props);
    if (!scales) return null;
    const { xScale, yScale } = scales;
    const corners = [
      safeZone.topLeft,
      safeZone.topRight,
      safeZone.bottomRight,
      safeZone.bottomLeft,
    ];
    const points = corners.map(corner => `${xScale(corner.DIC)},${yScale(corner.ALK)}`).join(' ');

    return (
      <polygon
        points={points}
        fill="#22c55e"
        fillOpacity={0.15}
        stroke="#16a34a"
        strokeWidth={1.5}
        strokeDasharray="4 4"
      />
    );
  };
}

function createDosingWedgeLayer(viz: DosingVisualization): React.FC<CustomizedLayerProps> {
  return function DosingWedgeLayer(props: CustomizedLayerProps) {
    const scales = getChartScales(props);
    if (!scales) return null;
    const { xScale, yScale } = scales;
    const polygonPoints: string[] = [];

    for (const point of viz.reagentLine1.points) {
      const px = xScale(point.CT);
      const py = yScale(point.AT);
      if (isFinite(px) && isFinite(py)) polygonPoints.push(`${px},${py}`);
    }
    for (let i = viz.reagentLine2.points.length - 1; i >= 0; i--) {
      const point = viz.reagentLine2.points[i];
      if (!point) continue;
      const px = xScale(point.CT);
      const py = yScale(point.AT);
      if (isFinite(px) && isFinite(py)) polygonPoints.push(`${px},${py}`);
    }

    if (polygonPoints.length < 3) return null;
    return (
      <polygon
        points={polygonPoints.join(' ')}
        fill="#f59e0b"
        fillOpacity={0.12}
        stroke="#f59e0b"
        strokeWidth={0}
      />
    );
  };
}

function createOnDemandArrowLayer(
  steps: OnDemandStep[],
  maxDIC: number,
  maxALK: number
): React.FC<CustomizedLayerProps> {
  return function OnDemandArrowLayer(props: CustomizedLayerProps) {
    const scales = getChartScales(props);
    if (!scales) return null;
    const { xScale, yScale } = scales;

    return (
      <g>
        {steps.slice(1).map((step, idx) => {
          const prev = steps[idx];
          if (!prev) return null;
          const cx = xScale(step.dic);
          const cy = yScale(step.alk);
          const px = xScale(prev.dic);
          const py = yScale(prev.alk);
          if (!isFinite(cx) || !isFinite(cy) || !isFinite(px) || !isFinite(py)) return null;

          const dx = (cx - px) / maxDIC;
          const dy = (cy - py) / maxALK;
          const angle = Math.atan2(dy, dx);
          const isLast = idx === steps.length - 2;
          const size = isLast ? 11 : 9;
          const color = idx === 0 ? '#f97316' : '#dc2626';
          const a1 = angle + Math.PI * 0.8;
          const a2 = angle - Math.PI * 0.8;

          return (
            <g key={`od-arrow-${idx}`}>
              <polygon
                points={`${cx},${cy} ${cx + size * Math.cos(a1)},${cy + size * Math.sin(a1)} ${cx + size * Math.cos(a2)},${cy + size * Math.sin(a2)}`}
                fill={color}
                stroke="white"
                strokeWidth={0.5}
              />
              {isLast && (
                <circle cx={cx} cy={cy} r={5} fill="#f97316" stroke="white" strokeWidth={1.5} />
              )}
            </g>
          );
        })}
      </g>
    );
  };
}

function createPHLabelLayer(
  isolines: PHIsoline[],
  maxDIC: number,
  maxALK: number
): React.FC<CustomizedLayerProps> {
  return function PHLabelLayer(props: CustomizedLayerProps) {
    const scales = getChartScales(props);
    if (!scales) return null;
    const { xScale, yScale } = scales;

    return (
      <g data-testid="deffeyes-ph-labels">
        {isolines.map((iso) => {
          const visiblePoints = iso.points.filter(
            point => point.CT >= 0 && point.CT <= maxDIC && point.AT >= 0 && point.AT <= maxALK
          );
          if (visiblePoints.length < 2) return null;

          const labelIndex = Math.min(
            visiblePoints.length - 2,
            Math.max(1, Math.floor((visiblePoints.length - 1) * 0.52))
          );
          const point = visiblePoints[labelIndex];
          const previous = visiblePoints[labelIndex - 1] ?? visiblePoints[0];
          const next = visiblePoints[labelIndex + 1] ?? visiblePoints[visiblePoints.length - 1];
          if (!point || !previous || !next) return null;

          const x = xScale(point.CT);
          const y = yScale(point.AT);
          const dx = xScale(next.CT) - xScale(previous.CT);
          const dy = yScale(next.AT) - yScale(previous.AT);
          if (!isFinite(x) || !isFinite(y) || !isFinite(dx) || !isFinite(dy)) return null;

          const angle = Math.max(-65, Math.min(65, Math.atan2(dy, dx) * 180 / Math.PI));

          return (
            <g key={`ph-label-${iso.pH}`} transform={`translate(${x} ${y}) rotate(${angle})`}>
              <text
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={11}
                fontWeight={700}
                fill={iso.color}
                stroke="#ffffff"
                strokeWidth={3}
                paintOrder="stroke"
              >
                {`pH ${iso.pH.toFixed(1)}`}
              </text>
            </g>
          );
        })}
      </g>
    );
  };
}

const DeffeyesChart: React.FC<DeffeyesChartProps> = ({
  data,
  maxDIC = 6,
  maxALK = 6,
  onDemandPath,
  forceSafetyOverlays = false,
}) => {
  const [showIsolines, setShowIsolines] = useState(true);
  const [showSafeZone, setShowSafeZone] = useState(false);
  const [showNH3Zone, setShowNH3Zone] = useState(false);
  const [showCO2Zone, setShowCO2Zone] = useState(false);
  const [showH2SZone, setShowH2SZone] = useState(false);
  const [showOmega, setShowOmega] = useState(false);

  // Render flags: the per-layer checkboxes drive normal display, but a report
  // export forces every toxicity overlay on without mutating user toggle state.
  const renderSafeZone = showSafeZone || forceSafetyOverlays;
  const renderNH3Zone = showNH3Zone || forceSafetyOverlays;
  const renderCO2Zone = showCO2Zone || forceSafetyOverlays;
  const renderH2SZone = showH2SZone || forceSafetyOverlays;
  const [showTarget, setShowTarget] = useState(true);
  const [showDosing, setShowDosing] = useState(true);
  const [showCurrentPoint, setShowCurrentPoint] = useState(true);
  const [showOnDemand, setShowOnDemand] = useState(true);

  const { major, minor } = useMemo(() => selectDisplayIsolines(data), [data]);

  const safeZone = data.safeZone;
  const dosingVisualization = data.dosingVisualization;
  const onDemandSteps = useMemo(
    () => onDemandPath && onDemandPath.length > 1 ? onDemandPath : [],
    [onDemandPath]
  );
  const SafeZoneLayer = useMemo(() => safeZone ? createSafeZoneLayer(safeZone) : null, [safeZone]);
  const DosingWedgeLayer = useMemo(
    () => dosingVisualization ? createDosingWedgeLayer(dosingVisualization) : null,
    [dosingVisualization]
  );
  const OnDemandArrowLayer = useMemo(
    () => onDemandSteps.length > 1 ? createOnDemandArrowLayer(onDemandSteps, maxDIC, maxALK) : null,
    [maxALK, maxDIC, onDemandSteps]
  );

  const visibleMajor = major.filter(iso => {
    const firstPt = iso.points[0];
    const lastPt = iso.points[iso.points.length - 1];
    return lastPt.AT > -2 && firstPt.AT < maxALK + 2;
  });

  const visibleMinor = minor.filter(iso => {
    const firstPt = iso.points[0];
    const lastPt = iso.points[iso.points.length - 1];
    return lastPt.AT > -2 && firstPt.AT < maxALK + 2;
  });
  const PHLabelLayer = createPHLabelLayer(visibleMajor, maxDIC, maxALK);

  // Prepare CO2 toxic zone data for Area component
  // Area with baseValue={0} fills between curve and X-axis
  const co2AreaData = useMemo(() => {
    if (!data.co2ToxicZone) return null;
    const clipped = clipCO2Boundary(data.co2ToxicZone.points, maxDIC, maxALK);
    return clipped.length >= 2 ? clipped : null;
  }, [data.co2ToxicZone, maxDIC, maxALK]);

  // H₂S toxic zone fills downward to the X-axis (low-pH region), exactly like
  // CO₂, so it reuses clipCO2Boundary + an Area with baseValue={0}.
  const h2sAreaData = useMemo(() => {
    if (!data.h2sToxicZone) return null;
    const clipped = clipCO2Boundary(data.h2sToxicZone.points, maxDIC, maxALK);
    return clipped.length >= 2 ? clipped : null;
  }, [data.h2sToxicZone, maxDIC, maxALK]);

  // Compute arrowhead for reagent line tip
  // The angle is in SVG coords (Y down), computed from last 2 data points
  const reagentArrow = useMemo(() => {
    if (!data.reagentLine || data.reagentLine.length < 2) return null;
    // Find last visible point within chart bounds
    const visible = data.reagentLine.filter(
      p => p.CT >= 0 && p.CT <= maxDIC && p.AT >= 0 && p.AT <= maxALK
    );
    if (visible.length < 2) return null;
    const last = visible[visible.length - 1];
    const prev = visible[visible.length - 2];
    // Data-space deltas, normalize by axis range to account for scale
    const dx = (last.CT - prev.CT) / maxDIC;
    const dy = (last.AT - prev.AT) / maxALK;
    // SVG Y is inverted (up = negative)
    const angle = Math.atan2(-dy, dx);
    return [{ CT: last.CT, AT: last.AT, angle }];
  }, [data.reagentLine, maxDIC, maxALK]);

  // Prepare NH3 toxic zone data for Area component
  // Area with baseValue={maxALK} fills between NH3 line and top (Y=maxALK)
  // This creates the wedge between NH3 line and Y-axis
  const nh3AreaData = useMemo(() => {
    if (!data.nh3ToxicZone) return null;
    const clipped = clipNH3Boundary(data.nh3ToxicZone.points, maxDIC, maxALK);
    return clipped.length >= 2 ? clipped : null;
  }, [data.nh3ToxicZone, maxDIC, maxALK]);

  return (
    <div className="bg-white rounded-xl shadow-lg border border-gray-200">
      <div className="px-6 py-4 border-b border-gray-200">
        <div className="text-center">
          <h3 className="text-lg font-bold text-gray-900">Water Quality Management Chart</h3>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-4 mt-3 pt-3 border-t border-gray-100">
          <LayerToggle label="pH Isolines" color="#3b82f6" checked={showIsolines} onChange={setShowIsolines} />
          <LayerToggle label="Safe Zone" color="#22c55e" checked={showSafeZone} onChange={setShowSafeZone} />
          <LayerToggle label="NH₃ Toxic" color="#ef4444" checked={showNH3Zone} onChange={setShowNH3Zone} />
          <LayerToggle label="CO₂ Toxic" color="#f97316" checked={showCO2Zone} onChange={setShowCO2Zone} />
          <LayerToggle label="H₂S Toxic" color="#b91c1c" checked={showH2SZone} onChange={setShowH2SZone} />
          <LayerToggle label="Ω Calcite/Ar" color="#8b5cf6" checked={showOmega} onChange={setShowOmega} />
          <LayerToggle label="Current" color="#2563eb" checked={showCurrentPoint} onChange={setShowCurrentPoint} />
          <LayerToggle label="Dosing Path" color="#f59e0b" checked={showDosing} onChange={setShowDosing} />
          <LayerToggle label="Target" color="#111827" checked={showTarget} onChange={setShowTarget} />
          {onDemandSteps.length > 1 && (
            <LayerToggle label="On-Demand" color="#f97316" checked={showOnDemand} onChange={setShowOnDemand} />
          )}
        </div>
      </div>
      <div className="p-4" style={{ height: 700 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart margin={{ top: 10, right: 20, left: 25, bottom: 35 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis
              dataKey="CT"
              type="number"
              domain={[0, maxDIC]}
              allowDataOverflow={true}
              tickCount={Math.min(maxDIC + 1, 17)}
              tick={{ fontSize: 11 }}
              label={{ value: 'DIC (mmol/L)', position: 'insideBottom', offset: -20, fontSize: 12, fill: '#374151' }}
            />
            <YAxis
              dataKey="AT"
              type="number"
              domain={[0, maxALK]}
              allowDataOverflow={true}
              tickCount={maxALK + 1}
              tick={{ fontSize: 11 }}
              label={{ value: 'Alkalinity (meq/L)', angle: -90, position: 'insideLeft', offset: -10, fontSize: 12, fill: '#374151' }}
            />
            <Tooltip
              formatter={(value: number, name: string) => [value.toFixed(3), name]}
              labelFormatter={(label) => `CT: ${label} mmol/L`}
            />

            {/* CO2 Toxic Zone - filled area between curve and X-axis */}
            {renderCO2Zone && co2AreaData && (
              <Area
                data={co2AreaData}
                dataKey="AT"
                baseValue={0}
                fill="rgba(249, 115, 22, 0.15)"
                stroke="#f97316"
                strokeWidth={1.5}
                strokeDasharray="6 3"
                dot={false}
                type="monotone"
                legendType="none"
                name="CO₂ Toxic Zone"
                isAnimationActive={false}
              />
            )}

            {/* H₂S Toxic Zone - filled area between critical-pH isoline and X-axis */}
            {renderH2SZone && h2sAreaData && (
              <Area
                data={h2sAreaData}
                dataKey="AT"
                baseValue={0}
                fill="rgba(185, 28, 28, 0.15)"
                stroke="#b91c1c"
                strokeWidth={1.5}
                strokeDasharray="6 3"
                dot={false}
                type="monotone"
                legendType="none"
                name="H₂S Toxic Zone"
                isAnimationActive={false}
              />
            )}

            {/* NH3 Toxic Zone - filled wedge between NH3 line and Y=maxALK */}
            {renderNH3Zone && nh3AreaData && (
              <Area
                data={nh3AreaData}
                dataKey="AT"
                baseValue={maxALK}
                fill="rgba(239, 68, 68, 0.18)"
                stroke="#ef4444"
                strokeWidth={1.5}
                strokeDasharray="6 3"
                dot={false}
                type="monotone"
                legendType="none"
                name="NH₃ Toxic Zone"
                isAnimationActive={false}
              />
            )}

            {/* Safe Zone (quadrilateral bounded by NH3 line, CO2 line, alkMin, alkMax) */}
            {renderSafeZone && SafeZoneLayer && <Customized component={SafeZoneLayer} />}

            {/* Minor pH isolines (thin, transparent) */}
            {showIsolines && visibleMinor.map((iso) => (
              <Line
                key={`minor-${iso.pH}`}
                data={iso.points}
                dataKey="AT"
                stroke={iso.color}
                strokeWidth={0.5}
                strokeOpacity={0.25}
                dot={false}
                type="monotone"
                legendType="none"
                name={`pH ${iso.pH.toFixed(2)}`}
                isAnimationActive={false}
              />
            ))}

            {/* Major pH isolines (semi-transparent) */}
            {showIsolines && visibleMajor.map((iso) => (
              <Line
                key={`major-${iso.pH}`}
                data={iso.points}
                dataKey="AT"
                name={`pH ${iso.pH.toFixed(1)}`}
                stroke={iso.color}
                strokeWidth={1.5}
                strokeOpacity={0.5}
                dot={false}
                type="monotone"
                legendType="none"
                isAnimationActive={false}
              />
            ))}
            {showIsolines && <Customized component={PHLabelLayer} />}

            {/* Reagent direction line */}
            {showDosing && data.reagentLine && (
              <Line
                data={data.reagentLine}
                dataKey="AT"
                name="Reagent Path"
                stroke="#f59e0b"
                strokeWidth={2}
                strokeDasharray="8 4"
                dot={false}
                type="monotone"
                legendType="none"
                isAnimationActive={false}
              />
            )}

            {/* Reagent arrowhead */}
            {showDosing && reagentArrow && (
              <Scatter
                data={reagentArrow}
                shape={<ArrowShape />}
                legendType="none"
                name="arrow"
                isAnimationActive={false}
              />
            )}

            {/* Two-reagent dosing visualization */}
            {showDosing && dosingVisualization && (
              <>
                {/* Reagent 1 direction line (from current point) */}
                <Line
                  data={dosingVisualization.reagentLine1.points}
                  dataKey="AT"
                  name={dosingVisualization.reagentLine1.label}
                  stroke={dosingVisualization.reagentLine1.color}
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                  strokeOpacity={0.6}
                  dot={false}
                  type="monotone"
                  legendType="none"
                  isAnimationActive={false}
                />
                {/* Reagent 2 direction line (from current point) */}
                <Line
                  data={dosingVisualization.reagentLine2.points}
                  dataKey="AT"
                  name={dosingVisualization.reagentLine2.label}
                  stroke={dosingVisualization.reagentLine2.color}
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                  strokeOpacity={0.6}
                  dot={false}
                  type="monotone"
                  legendType="none"
                  isAnimationActive={false}
                />

                {/* Step1/step2 bold path + intermediate point (only when target ON and dosing path computed) */}
                {showTarget && dosingVisualization.step1Path.length > 0 && (
                  <>
                    <Line
                      data={dosingVisualization.step1Path}
                      dataKey="AT"
                      name={dosingVisualization.step1Label}
                      stroke={dosingVisualization.reagentLine1.color}
                      strokeWidth={3}
                      dot={false}
                      type="monotone"
                      legendType="none"
                      isAnimationActive={false}
                    />
                    <Line
                      data={dosingVisualization.step2Path}
                      dataKey="AT"
                      name={dosingVisualization.step2Label}
                      stroke={dosingVisualization.reagentLine2.color}
                      strokeWidth={3}
                      dot={false}
                      type="monotone"
                      legendType="none"
                      isAnimationActive={false}
                    />
                    <Scatter
                      data={[{ CT: dosingVisualization.intermediatePoint.DIC, AT: dosingVisualization.intermediatePoint.ALK }]}
                      name="Intermediate"
                      shape={<DiamondShape />}
                      legendType="none"
                      isAnimationActive={false}
                    />
                  </>
                )}

                {/* Reachable wedge (filled area between two reagent lines) - always shown */}
                {DosingWedgeLayer && <Customized component={DosingWedgeLayer} />}
              </>
            )}

            {/* Omega Calcite isopleth (Ω=1) */}
            {showOmega && data.omegaCalcite && (
              <Line
                data={data.omegaCalcite.points}
                dataKey="AT"
                name="Ω-Calcite=1"
                stroke="#2563eb"
                strokeWidth={2}
                strokeDasharray="8 4"
                dot={false}
                type="monotone"
                legendType="none"
                isAnimationActive={false}
              />
            )}

            {/* Omega Aragonite isopleth (Ω=1) */}
            {showOmega && data.omegaAragonite && (
              <Line
                data={data.omegaAragonite.points}
                dataKey="AT"
                name="Ω-Aragonite=1"
                stroke="#d946ef"
                strokeWidth={2}
                strokeDasharray="8 4"
                dot={false}
                type="monotone"
                legendType="none"
                isAnimationActive={false}
              />
            )}

            {/* Dashed line from current to target */}
            {showTarget && data.targetPoint && (
              <Line
                data={[
                  { CT: data.currentPoint.DIC, AT: data.currentPoint.ALK },
                  { CT: data.targetPoint.DIC, AT: data.targetPoint.ALK },
                ]}
                dataKey="AT"
                name="Path to Target"
                stroke="#6b7280"
                strokeWidth={1.5}
                strokeDasharray="6 4"
                dot={false}
                type="monotone"
                legendType="none"
                isAnimationActive={false}
              />
            )}

            {/* Current operating point (blue star) */}
            {showCurrentPoint && (
              <Scatter
                name="Current Point"
                data={[{ CT: data.currentPoint.DIC, AT: data.currentPoint.ALK }]}
                shape={<StarShape />}
                legendType="none"
                isAnimationActive={false}
              />
            )}

            {/* Target point (black X) */}
            {showTarget && data.targetPoint && (
              <Scatter
                name="Target Point"
                data={[{ CT: data.targetPoint.DIC, AT: data.targetPoint.ALK }]}
                shape={<CrossShape />}
                legendType="none"
                isAnimationActive={false}
              />
            )}

            {/* On-Demand path: arrows from step to step */}
            {showOnDemand && onDemandSteps.length > 1 && (
              <>
                {/* Arrow segments between consecutive steps */}
                {onDemandSteps.slice(0, -1).map((step, idx) => {
                  const next = onDemandSteps[idx + 1];
                  if (!next) return null;
                  const segColor = idx === 0 ? '#f97316' : '#dc2626';
                  return (
                    <Line
                      key={`od-seg-${idx}`}
                      data={[
                        { CT: step.dic, AT: step.alk },
                        { CT: next.dic, AT: next.alk },
                      ]}
                      dataKey="AT"
                      stroke={segColor}
                      strokeWidth={2.5}
                      dot={false}
                      type="linear"
                      legendType="none"
                      isAnimationActive={false}
                    />
                  );
                })}

                {/* Arrowheads at each intermediate/final point (using Customized) */}
                {OnDemandArrowLayer && <Customized component={OnDemandArrowLayer} />}
              </>
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

export default DeffeyesChart;
