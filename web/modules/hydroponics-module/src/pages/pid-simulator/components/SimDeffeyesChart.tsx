/**
 * Deffeyes Diagram for PID Simulator
 * pH isolines + reagent directions + real-time operating point trail
 */
import React, { useMemo } from 'react';
import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Scatter,
  ResponsiveContainer,
  Customized,
} from 'recharts';
import { generatePHIsolines, PHIsoline } from '../engine/deffeyes-calc';
import { HYDRO_REAGENTS, reagentDirectionLine } from '../engine/reagents';
import { calcDicOfAlk } from '../engine/carbonate-chemistry';

interface SimDeffeyesChartProps {
  pH: number;
  ALK: number;
  targetPH: number;
  targetALK: number;
  tempC: number;
  salinity: number;
  trail: Array<{ CT: number; AT: number }>;
}

const MAX_DIC = 5;
const MAX_ALK = 5;

/** Custom shape: pulsing blue circle for current point */
const PulseCircle: React.FC<any> = (props) => {
  const { cx, cy } = props;
  if (cx == null || cy == null) return null;
  return (
    <g>
      <circle cx={cx} cy={cy} r={8} fill="#2563eb" fillOpacity={0.25}>
        <animate attributeName="r" values="6;10;6" dur="1.5s" repeatCount="indefinite" />
        <animate attributeName="fill-opacity" values="0.3;0.1;0.3" dur="1.5s" repeatCount="indefinite" />
      </circle>
      <circle cx={cx} cy={cy} r={5} fill="#2563eb" stroke="#1d4ed8" strokeWidth={1.5} />
    </g>
  );
};

/** Custom shape: black X for target */
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

function selectDisplayIsolines(isolines: PHIsoline[]) {
  const majorPHs = new Set<number>();
  for (let pH = 4.0; pH <= 9.0; pH += 0.5) {
    majorPHs.add(parseFloat(pH.toFixed(2)));
  }
  return {
    major: isolines.filter(iso => majorPHs.has(iso.pH)),
    minor: isolines.filter(iso => !majorPHs.has(iso.pH)),
  };
}

const SimDeffeyesChart: React.FC<SimDeffeyesChartProps> = ({
  pH, ALK, targetPH, targetALK, tempC, salinity, trail,
}) => {
  const isolines = useMemo(() => generatePHIsolines(tempC, salinity, MAX_DIC), [tempC, salinity]);
  const { major, minor } = useMemo(() => selectDisplayIsolines(isolines), [isolines]);

  const currentDIC = useMemo(() => calcDicOfAlk(ALK, pH, tempC, salinity), [ALK, pH, tempC, salinity]);
  const targetDIC = useMemo(() => calcDicOfAlk(targetALK, targetPH, tempC, salinity), [targetALK, targetPH, tempC, salinity]);

  // Reagent direction lines from current point
  const reagentLines = useMemo(() => {
    return HYDRO_REAGENTS.map(r => ({
      reagent: r,
      points: reagentDirectionLine(currentDIC, ALK, r, 2.5),
    }));
  }, [currentDIC, ALK]);

  const visibleMajor = major.filter(iso => {
    const last = iso.points[iso.points.length - 1];
    return last.AT > -1 && iso.points[0].AT < MAX_ALK + 1;
  });
  const visibleMinor = minor.filter(iso => {
    const last = iso.points[iso.points.length - 1];
    return last.AT > -1 && iso.points[0].AT < MAX_ALK + 1;
  });

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-3">
      <h3 className="text-sm font-semibold text-gray-700 mb-2 text-center">
        Deffeyes Diagram (ALK vs DIC)
      </h3>
      <div style={{ height: 460 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart margin={{ top: 5, right: 15, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis
              dataKey="CT"
              type="number"
              domain={[0, MAX_DIC]}
              allowDataOverflow
              tickCount={6}
              tick={{ fontSize: 10 }}
              label={{ value: 'DIC (mmol/L)', position: 'insideBottom', offset: -2, fontSize: 10 }}
            />
            <YAxis
              dataKey="AT"
              type="number"
              domain={[0, MAX_ALK]}
              allowDataOverflow
              tickCount={6}
              tick={{ fontSize: 10 }}
              label={{ value: 'ALK (meq/L)', angle: -90, position: 'insideLeft', offset: 10, fontSize: 10 }}
            />

            {/* Minor pH isolines */}
            {visibleMinor.map(iso => (
              <Line
                key={`m-${iso.pH}`}
                data={iso.points}
                dataKey="AT"
                stroke={iso.color}
                strokeWidth={0.5}
                strokeOpacity={0.2}
                dot={false}
                type="monotone"
                legendType="none"
                isAnimationActive={false}
              />
            ))}

            {/* Major pH isolines with labels */}
            {visibleMajor.map(iso => (
              <Line
                key={`M-${iso.pH}`}
                data={iso.points}
                dataKey="AT"
                name={`pH ${iso.pH.toFixed(1)}`}
                stroke={iso.color}
                strokeWidth={1.2}
                strokeOpacity={0.5}
                dot={false}
                type="monotone"
                legendType="none"
                isAnimationActive={false}
              />
            ))}

            {/* Target pH isoline (thick green dashed) */}
            {visibleMajor.concat(visibleMinor).filter(iso =>
              Math.abs(iso.pH - targetPH) < 0.13
            ).map(iso => (
              <Line
                key={`tgt-${iso.pH}`}
                data={iso.points}
                dataKey="AT"
                stroke="#16a34a"
                strokeWidth={2}
                strokeDasharray="6 3"
                dot={false}
                type="monotone"
                legendType="none"
                isAnimationActive={false}
              />
            ))}

            {/* Reagent direction lines */}
            {reagentLines.map(({ reagent, points }) => (
              <Line
                key={`r-${reagent.name}`}
                data={points}
                dataKey="AT"
                stroke={reagent.color}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                strokeOpacity={0.6}
                dot={false}
                type="monotone"
                legendType="none"
                isAnimationActive={false}
              />
            ))}

            {/* Reagent arrowheads */}
            <Customized
              component={(props: any) => {
                const { xAxisMap, yAxisMap } = props;
                if (!xAxisMap || !yAxisMap) return null;
                const xAxis = Object.values(xAxisMap)[0] as any;
                const yAxis = Object.values(yAxisMap)[0] as any;
                if (!xAxis?.scale || !yAxis?.scale) return null;
                const xScale = xAxis.scale;
                const yScale = yAxis.scale;

                return (
                  <g>
                    {reagentLines.map(({ reagent, points }) => {
                      const visible = points.filter(
                        p => p.CT >= 0 && p.CT <= MAX_DIC && p.AT >= 0 && p.AT <= MAX_ALK
                      );
                      if (visible.length < 2) return null;
                      const tip = visible[visible.length - 1];
                      const prev = visible[visible.length - 2];
                      const dx = (tip.CT - prev.CT) / MAX_DIC;
                      const dy = (tip.AT - prev.AT) / MAX_ALK;
                      const angle = Math.atan2(-dy, dx);
                      const cx = xScale(tip.CT);
                      const cy = yScale(tip.AT);
                      if (!isFinite(cx) || !isFinite(cy)) return null;
                      const sz = 8;
                      const a1 = angle + Math.PI * 0.82;
                      const a2 = angle - Math.PI * 0.82;
                      return (
                        <polygon
                          key={`arr-${reagent.name}`}
                          points={`${cx},${cy} ${cx + sz * Math.cos(a1)},${cy + sz * Math.sin(a1)} ${cx + sz * Math.cos(a2)},${cy + sz * Math.sin(a2)}`}
                          fill={reagent.color}
                          fillOpacity={0.6}
                        />
                      );
                    })}
                  </g>
                );
              }}
            />

            {/* Operating point trail */}
            {trail.length > 1 && (
              <Line
                data={trail}
                dataKey="AT"
                stroke="#93c5fd"
                strokeWidth={1.5}
                strokeOpacity={0.6}
                dot={false}
                type="monotone"
                legendType="none"
                isAnimationActive={false}
              />
            )}

            {/* Trail points with fading opacity */}
            <Customized
              component={(props: any) => {
                const { xAxisMap, yAxisMap } = props;
                if (!xAxisMap || !yAxisMap) return null;
                const xAxis = Object.values(xAxisMap)[0] as any;
                const yAxis = Object.values(yAxisMap)[0] as any;
                if (!xAxis?.scale || !yAxis?.scale) return null;
                const xScale = xAxis.scale;
                const yScale = yAxis.scale;

                return (
                  <g>
                    {trail.map((pt, i) => {
                      const cx = xScale(pt.CT);
                      const cy = yScale(pt.AT);
                      if (!isFinite(cx) || !isFinite(cy)) return null;
                      const opacity = 0.1 + (i / trail.length) * 0.5;
                      return (
                        <circle
                          key={`trail-${i}`}
                          cx={cx}
                          cy={cy}
                          r={1.5}
                          fill="#3b82f6"
                          fillOpacity={opacity}
                        />
                      );
                    })}
                  </g>
                );
              }}
            />

            {/* Target point (X) */}
            <Scatter
              data={[{ CT: targetDIC, AT: targetALK }]}
              shape={<CrossShape />}
              legendType="none"
              isAnimationActive={false}
            />

            {/* Current point (pulsing circle) */}
            <Scatter
              data={[{ CT: currentDIC, AT: ALK }]}
              shape={<PulseCircle />}
              legendType="none"
              isAnimationActive={false}
            />

            {/* pH isoline labels */}
            <Customized
              component={(props: any) => {
                const { xAxisMap, yAxisMap } = props;
                if (!xAxisMap || !yAxisMap) return null;
                const xAxis = Object.values(xAxisMap)[0] as any;
                const yAxis = Object.values(yAxisMap)[0] as any;
                if (!xAxis?.scale || !yAxis?.scale) return null;
                const xScale = xAxis.scale;
                const yScale = yAxis.scale;

                return (
                  <g>
                    {visibleMajor.map(iso => {
                      // Place label at DIC = maxDIC * 0.85
                      const targetCT = MAX_DIC * 0.85;
                      const pt = iso.points.find(p => p.CT >= targetCT);
                      if (!pt || pt.AT < 0 || pt.AT > MAX_ALK) return null;
                      const x = xScale(pt.CT);
                      const y = yScale(pt.AT);
                      if (!isFinite(x) || !isFinite(y)) return null;
                      return (
                        <text
                          key={`lbl-${iso.pH}`}
                          x={x + 2}
                          y={y - 3}
                          fontSize={8}
                          fill={iso.color}
                          fillOpacity={0.7}
                        >
                          {iso.pH.toFixed(1)}
                        </text>
                      );
                    })}
                  </g>
                );
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {/* Legend for reagent lines */}
      <div className="flex flex-wrap gap-3 mt-1 px-2 justify-center">
        {HYDRO_REAGENTS.map(r => (
          <span key={r.name} className="flex items-center gap-1 text-[10px] text-gray-600">
            <span className="inline-block w-3 h-0.5" style={{ backgroundColor: r.color }} />
            {r.formula}
          </span>
        ))}
      </div>
    </div>
  );
};

export default SimDeffeyesChart;
