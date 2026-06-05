/**
 * DIC vs pH chart for water chemistry management.
 *
 * This renderer consumes pH-projected data and leaves the legacy ALK/DIC
 * Deffeyes renderer intact for rollback.
 */
import React, { useMemo, useState } from 'react';
import {
  CartesianGrid,
  ComposedChart,
  Customized,
  Label,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { DeffeyesPHChartData, DicPhPoint, DicPhSegment } from '@platform/aquaculture-engines';

interface DeffeyesPhChartProps {
  data: DeffeyesPHChartData;
  onDemandPath?: DicPhPoint[];
  onDemandSegments?: DicPhSegment[];
  forceSafetyOverlays?: boolean;
}

const StarShape: React.FC<any> = (props) => {
  const { cx, cy } = props;
  if (cx == null || cy == null) return null;
  const r = 8;
  const points: string[] = [];
  for (let i = 0; i < 5; i++) {
    const angle = ((i * 72 - 90) * Math.PI) / 180;
    points.push(`${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`);
    const innerAngle = (((i * 72 + 36) - 90) * Math.PI) / 180;
    points.push(`${cx + r * 0.4 * Math.cos(innerAngle)},${cy + r * 0.4 * Math.sin(innerAngle)}`);
  }
  return <polygon points={points.join(' ')} fill="#2563eb" stroke="#1d4ed8" strokeWidth={1} />;
};

const CrossShape: React.FC<any> = (props) => {
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

const DiamondShape: React.FC<any> = (props) => {
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

const ArrowShape: React.FC<any> = (props) => {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null) return null;
  const angle = payload?.angle ?? 0;
  const size = 12;
  const a1 = angle + Math.PI * 0.82;
  const a2 = angle - Math.PI * 0.82;
  return (
    <polygon
      points={`${cx},${cy} ${cx + size * Math.cos(a1)},${cy + size * Math.sin(a1)} ${cx + size * Math.cos(a2)},${cy + size * Math.sin(a2)}`}
      fill="#f59e0b"
      stroke="#d97706"
      strokeWidth={1}
    />
  );
};

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

function polygonLayer(
  polygons: DicPhPoint[][],
  fill: string,
  stroke: string,
  strokeWidth = 0,
  strokeDasharray?: string,
  layerId?: string
) {
  return (props: any) => {
    const { xAxisMap, yAxisMap } = props;
    if (!xAxisMap || !yAxisMap) return null;
    const xAxis = Object.values(xAxisMap)[0] as any;
    const yAxis = Object.values(yAxisMap)[0] as any;
    if (!xAxis?.scale || !yAxis?.scale) return null;

    return (
      <g data-testid={layerId} data-layer-id={layerId}>
        {polygons.map((polygon, idx) => {
          const points = polygon
            .map((point) => {
              const x = xAxis.scale(point.CT);
              const y = yAxis.scale(point.pH);
              return isFinite(x) && isFinite(y) ? `${x},${y}` : null;
            })
            .filter((point): point is string => point != null);
          if (points.length < 3) return null;
          return (
            <polygon
              key={idx}
              points={points.join(' ')}
              fill={fill}
              stroke={stroke}
              strokeWidth={strokeWidth}
              strokeDasharray={strokeDasharray}
              data-layer-id={layerId ? `${layerId}-polygon` : undefined}
            />
          );
        })}
      </g>
    );
  };
}

const DeffeyesPhChart: React.FC<DeffeyesPhChartProps> = ({ data, onDemandPath, onDemandSegments, forceSafetyOverlays = false }) => {
  const [showAlkalinityLines, setShowAlkalinityLines] = useState(true);
  const [showSafeZone, setShowSafeZone] = useState(true);
  const [showNH3Zone, setShowNH3Zone] = useState(true);
  const [showCO2Zone, setShowCO2Zone] = useState(true);
  const [showH2SZone, setShowH2SZone] = useState(true);
  const [showOmega, setShowOmega] = useState(false);
  const [showTarget, setShowTarget] = useState(true);
  const [showDosing, setShowDosing] = useState(true);
  const [showCurrentPoint, setShowCurrentPoint] = useState(true);
  const [showOnDemand, setShowOnDemand] = useState(true);

  const { maxDIC, minPH, maxPH } = data.domain;
  const visibleSafeZone = showSafeZone || forceSafetyOverlays;
  const visibleNH3Zone = showNH3Zone || forceSafetyOverlays;
  const visibleCO2Zone = showCO2Zone || forceSafetyOverlays;
  const visibleH2SZone = showH2SZone || forceSafetyOverlays;
  const targetPathSegments = data.targetPathSegments?.length
    ? data.targetPathSegments
    : data.targetPath && data.targetPath.length > 1
      ? [data.targetPath]
      : data.targetPoint
        ? [[data.currentPoint, data.targetPoint]]
        : [];
  const onDemandPathSegments = onDemandSegments?.length
    ? onDemandSegments
    : onDemandPath && onDemandPath.length > 1
      ? [onDemandPath]
      : [];
  const reagentLineSegments = useMemo(
    () => data.reagentLineSegments?.length
      ? data.reagentLineSegments
      : data.reagentLine && data.reagentLine.length > 1
        ? [data.reagentLine]
        : [],
    [data.reagentLine, data.reagentLineSegments]
  );

  const reagentArrow = useMemo(() => {
    let visible: DicPhPoint[] = [];
    for (let idx = reagentLineSegments.length - 1; idx >= 0; idx--) {
      visible = (reagentLineSegments[idx] ?? []).filter(
        p => p.CT >= 0 && p.CT <= maxDIC && p.pH >= minPH && p.pH <= maxPH
      );
      if (visible.length >= 2) break;
    }
    if (visible.length < 2) return null;
    const last = visible[visible.length - 1];
    const prev = visible[visible.length - 2];
    if (!last || !prev) return null;
    const dx = (last.CT - prev.CT) / maxDIC;
    const dy = (last.pH - prev.pH) / (maxPH - minPH);
    const angle = Math.atan2(-dy, dx);
    return [{ CT: last.CT, pH: last.pH, angle }];
  }, [maxDIC, maxPH, minPH, reagentLineSegments]);

  return (
    <div
      className="bg-white rounded-xl shadow-lg border border-gray-200"
      data-report-chart-id="deffeyes"
      data-testid="deffeyes-ph-chart"
      data-reagent-line-segments={reagentLineSegments.length}
    >
      <div className="px-6 py-4 border-b border-gray-200">
        <div className="text-center">
          <h3 className="text-lg font-bold text-gray-900">Water Quality Management Chart</h3>
          <p className="text-xs text-gray-500 mt-0.5">DIC vs pH with NH₃, CO₂, and H₂S risk overlays</p>
        </div>
        <div
          className="flex flex-wrap items-center justify-center gap-4 mt-3 pt-3 border-t border-gray-100"
          data-testid="deffeyes-layer-toggle-bar"
        >
          <LayerToggle label="Alkalinity Lines" color="#3b82f6" checked={showAlkalinityLines} onChange={setShowAlkalinityLines} />
          <LayerToggle label="Safe Zone" color="#22c55e" checked={showSafeZone} onChange={setShowSafeZone} />
          <LayerToggle label="NH₃ Toxic" color="#ef4444" checked={showNH3Zone} onChange={setShowNH3Zone} />
          <LayerToggle label="CO₂ Toxic" color="#f97316" checked={showCO2Zone} onChange={setShowCO2Zone} />
          <LayerToggle label="H₂S Toxic" color="#b91c1c" checked={showH2SZone} onChange={setShowH2SZone} />
          <LayerToggle label="Ω Calcite/Ar" color="#8b5cf6" checked={showOmega} onChange={setShowOmega} />
          <LayerToggle label="Current" color="#2563eb" checked={showCurrentPoint} onChange={setShowCurrentPoint} />
          <LayerToggle label="Dosing Path" color="#f59e0b" checked={showDosing} onChange={setShowDosing} />
          <LayerToggle label="Target" color="#111827" checked={showTarget} onChange={setShowTarget} />
          {onDemandPathSegments.length > 0 && (
            <LayerToggle label="On-Demand" color="#f97316" checked={showOnDemand} onChange={setShowOnDemand} />
          )}
        </div>
      </div>
      <div className="p-4" style={{ height: 700 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart margin={{ top: 10, right: 28, left: 18, bottom: 34 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis
              dataKey="CT"
              type="number"
              domain={[0, maxDIC]}
              allowDataOverflow={true}
              tickCount={Math.min(maxDIC + 1, 17)}
              tick={{ fontSize: 11 }}
            >
              <Label value="DIC / CT (mmol/L)" offset={-18} position="insideBottom" style={{ fontSize: 12 }} />
            </XAxis>
            <YAxis
              dataKey="pH"
              type="number"
              domain={[minPH, maxPH]}
              allowDataOverflow={true}
              tickCount={10}
              tick={{ fontSize: 11 }}
            >
              <Label value="pH (NBS)" angle={-90} position="insideLeft" offset={-8} style={{ fontSize: 12 }} />
            </YAxis>
            <Tooltip
              formatter={(value: number, name: string) => [value.toFixed(3), name]}
              labelFormatter={(label) => `DIC: ${Number(label).toFixed(3)} mmol/L`}
            />

            {visibleSafeZone && data.safeBands.map((band, idx) => (
              <Customized
                key={`safe-${idx}`}
                component={polygonLayer(band.polygons, 'rgba(34, 197, 94, 0.15)', '#16a34a', 1.5, '4 4', 'deffeyes-layer-safe-zone')}
              />
            ))}

            {visibleCO2Zone && data.co2ToxicZone && (
              <Customized component={polygonLayer(data.co2ToxicZone.polygons, data.co2ToxicZone.fillColor, data.co2ToxicZone.color, 1, undefined, 'deffeyes-layer-co2-toxic')} />
            )}
            {visibleH2SZone && data.h2sToxicZone && (
              <Customized component={polygonLayer(data.h2sToxicZone.polygons, data.h2sToxicZone.fillColor, data.h2sToxicZone.color, 1, undefined, 'deffeyes-layer-h2s-toxic')} />
            )}
            {visibleNH3Zone && data.nh3ToxicZone && (
              <Customized component={polygonLayer(data.nh3ToxicZone.polygons, data.nh3ToxicZone.fillColor, data.nh3ToxicZone.color, 1, undefined, 'deffeyes-layer-nh3-toxic')} />
            )}

            {data.pHReferences.map((line) => (
              <Line
                key={line.label}
                data={line.points}
                dataKey="pH"
                name={line.label}
                stroke={line.color}
                strokeWidth={0.75}
                strokeDasharray="3 6"
                strokeOpacity={0.35}
                dot={false}
                type="linear"
                legendType="none"
                isAnimationActive={false}
              />
            ))}

            {showAlkalinityLines && data.alkalinityLines.map((line) => (
              <Line
                key={line.label}
                data={line.points}
                dataKey="pH"
                name={line.label}
                stroke={line.color}
                strokeWidth={line.label.startsWith('Current') ? 2 : 1.25}
                strokeOpacity={0.65}
                dot={false}
                type="linear"
                legendType="none"
                isAnimationActive={false}
              />
            ))}

            {visibleCO2Zone && data.co2ToxicZone && (data.co2ToxicZone.boundarySegments?.length ? data.co2ToxicZone.boundarySegments : [data.co2ToxicZone.boundary]).map((segment, idx) => (
              <Line key={`co2-boundary-${idx}`} data={segment} dataKey="pH" name="CO₂ Toxic Boundary" stroke={data.co2ToxicZone!.color} strokeWidth={1.5} dot={false} type="linear" legendType="none" isAnimationActive={false} />
            ))}
            {visibleH2SZone && data.h2sToxicZone && (data.h2sToxicZone.boundarySegments?.length ? data.h2sToxicZone.boundarySegments : [data.h2sToxicZone.boundary]).map((segment, idx) => (
              <Line key={`h2s-boundary-${idx}`} data={segment} dataKey="pH" name="H₂S Toxic Boundary" stroke={data.h2sToxicZone!.color} strokeWidth={1.5} dot={false} type="linear" legendType="none" isAnimationActive={false} />
            ))}
            {visibleNH3Zone && data.nh3ToxicZone && (data.nh3ToxicZone.boundarySegments?.length ? data.nh3ToxicZone.boundarySegments : [data.nh3ToxicZone.boundary]).map((segment, idx) => (
              <Line key={`nh3-boundary-${idx}`} data={segment} dataKey="pH" name="NH₃ Toxic Boundary" stroke={data.nh3ToxicZone!.color} strokeWidth={1.5} dot={false} type="linear" legendType="none" isAnimationActive={false} />
            ))}

            {showDosing && reagentLineSegments.map((segment, idx) => (
              <Line key={`reagent-path-${idx}`} data={segment} dataKey="pH" name="Reagent Path" stroke="#f59e0b" strokeWidth={2} strokeDasharray="8 4" dot={false} type="linear" legendType="none" isAnimationActive={false} data-testid={`deffeyes-reagent-path-segment-${idx}`} />
            ))}
            {showDosing && reagentArrow && (
              <Scatter data={reagentArrow} shape={<ArrowShape />} legendType="none" name="arrow" isAnimationActive={false} />
            )}

            {showDosing && data.dosingVisualization && (
              <>
                {(data.dosingVisualization.reagentLine1Segments?.length ? data.dosingVisualization.reagentLine1Segments : [data.dosingVisualization.reagentLine1.points]).map((segment, idx) => (
                  <Line key={`dose-line-1-${idx}`} data={segment} dataKey="pH" name={data.dosingVisualization!.reagentLine1.label} stroke={data.dosingVisualization!.reagentLine1.color} strokeWidth={1.5} strokeDasharray="4 4" strokeOpacity={0.6} dot={false} type="linear" legendType="none" isAnimationActive={false} />
                ))}
                {(data.dosingVisualization.reagentLine2Segments?.length ? data.dosingVisualization.reagentLine2Segments : [data.dosingVisualization.reagentLine2.points]).map((segment, idx) => (
                  <Line key={`dose-line-2-${idx}`} data={segment} dataKey="pH" name={data.dosingVisualization!.reagentLine2.label} stroke={data.dosingVisualization!.reagentLine2.color} strokeWidth={1.5} strokeDasharray="4 4" strokeOpacity={0.6} dot={false} type="linear" legendType="none" isAnimationActive={false} />
                ))}
                {showTarget && (data.dosingVisualization.step1Path.length > 0 || (data.dosingVisualization.step1PathSegments?.length ?? 0) > 0) && (
                  <>
                    {(data.dosingVisualization.step1PathSegments?.length ? data.dosingVisualization.step1PathSegments : [data.dosingVisualization.step1Path]).map((segment, idx) => (
                      <Line key={`dose-step-1-${idx}`} data={segment} dataKey="pH" name={data.dosingVisualization!.step1Label} stroke={data.dosingVisualization!.reagentLine1.color} strokeWidth={3} dot={false} type="linear" legendType="none" isAnimationActive={false} />
                    ))}
                    {(data.dosingVisualization.step2PathSegments?.length ? data.dosingVisualization.step2PathSegments : [data.dosingVisualization.step2Path]).map((segment, idx) => (
                      <Line key={`dose-step-2-${idx}`} data={segment} dataKey="pH" name={data.dosingVisualization!.step2Label} stroke={data.dosingVisualization!.reagentLine2.color} strokeWidth={3} dot={false} type="linear" legendType="none" isAnimationActive={false} />
                    ))}
                    {data.dosingVisualization.intermediatePoint && (
                      <Scatter data={[data.dosingVisualization.intermediatePoint]} name="Intermediate" shape={<DiamondShape />} legendType="none" isAnimationActive={false} />
                    )}
                  </>
                )}
              </>
            )}

            {showOmega && data.omegaCalcite && (
              <Line data={data.omegaCalcite.points} dataKey="pH" name="Ω-Calcite=1" stroke="#2563eb" strokeWidth={2} strokeDasharray="8 4" dot={false} type="linear" legendType="none" isAnimationActive={false} />
            )}
            {showOmega && data.omegaAragonite && (
              <Line data={data.omegaAragonite.points} dataKey="pH" name="Ω-Aragonite=1" stroke="#d946ef" strokeWidth={2} strokeDasharray="8 4" dot={false} type="linear" legendType="none" isAnimationActive={false} />
            )}

            {showCurrentPoint && showTarget && data.targetPoint && targetPathSegments.map((segment, idx) => (
              <Line
                key={`target-path-${idx}`}
                data={segment}
                dataKey="pH"
                name="Path to Target"
                stroke="#6b7280"
                strokeWidth={1.5}
                strokeDasharray="6 4"
                dot={false}
                type="linear"
                legendType="none"
                isAnimationActive={false}
              />
            ))}

            {showOnDemand && onDemandPathSegments.map((segment, idx) => (
              <Line key={`on-demand-${idx}`} data={segment} dataKey="pH" name="On-Demand Path" stroke="#f97316" strokeWidth={2.5} dot={false} type="linear" legendType="none" isAnimationActive={false} />
            ))}

            {showCurrentPoint && (
              <Scatter name="Current Point" data={[data.currentPoint]} shape={<StarShape />} legendType="none" isAnimationActive={false} />
            )}
            {showTarget && data.targetPoint && (
              <Scatter name="Target Point" data={[data.targetPoint]} shape={<CrossShape />} legendType="none" isAnimationActive={false} />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

export default DeffeyesPhChart;
