/**
 * TrendChartRenderer - SVG polyline trend chart with time range selector,
 * multi-trace support, CSV export, and simulation accumulation.
 *
 * Modes:
 *  1. Edit mode   — deterministic sine-wave demo data
 *  2. Simulation  — accumulates simTagValues over time from the store
 *  3. Preview     — uses useScadaTrend hook (mock data until backend ready)
 */

import React, { memo, useMemo, useState, useCallback, useRef, useEffect } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';
import { useScadaPackageStore } from '../../../store/scada';
import {
  TRACE_COLORS, TIME_RANGES, formatTimeLabel, generateDemoTraces,
  computeYDomain, niceStep, exportCsv,
} from './trendChartUtils';
import type { SimPoint, TimeRangeKey } from './trendChartUtils';

const TrendChartRenderer: React.FC<WidgetRendererProps> = ({ config, width, height, isEditing }) => {
  const label = (config.label as string) ?? 'Trend';
  const tags: string[] = useMemo(() => {
    const raw = (config.tags ?? config.trendTags ?? []) as string[];
    return raw.length > 0 ? raw : ['Tag1', 'Tag2'];
  }, [config.tags, config.trendTags]);

  const showGrid = (config.showGrid as boolean) ?? true;
  const showLegend = (config.showLegend as boolean) ?? true;
  const defaultRange = ((config.defaultRange ?? config.timeRange ?? '24h') as string) as TimeRangeKey;

  const [selectedRange, setSelectedRange] = useState<TimeRangeKey>(defaultRange);
  const rangeMs = TIME_RANGES.find((r) => r.key === selectedRange)?.ms ?? 86_400_000;

  /* ---------- Simulation accumulation ------------------------------ */
  const simulationMode = useScadaPackageStore((s) => s.simulationMode);
  const simTagValues = useScadaPackageStore((s) => s.simTagValues);
  const simBufferRef = useRef<SimPoint[]>([]);

  /**
   * Veri tutarlılığı düzeltmesi: Eski implementasyonda useEffect ref'i render
   * sonrası mutate ediyordu ama useMemo render sırasında okuyordu — ref her zaman
   * 1 frame geride kalıyordu.
   *
   * Stale ref fix: The old implementation mutated simBufferRef in useEffect
   * (post-render) but useMemo read it during render — ref was always 1 frame behind.
   *
   * Yeni yaklaşım: Buffer yönetimi useMemo içinde yapılır, böylece
   * render cycle içinde tutarlılık sağlanır. Ref sadece useMemo'nun buffer'ı
   * sonraki render'a taşıması için persistence sağlar.
   *
   * New approach: Buffer management is done inside useMemo, ensuring
   * consistency within the render cycle. Ref only provides persistence
   * for the buffer across renders.
   */

  /* ---------- Chart data ------------------------------------------- */
  const chartData = useMemo<SimPoint[]>(() => {
    // Edit veya simülasyon dışı modda demo veri göster
    // Show demo data in edit or non-simulation mode
    if (isEditing || !simulationMode) {
      simBufferRef.current = [];
      return generateDemoTraces(tags, 30);
    }

    // Simülasyon modunda buffer'ı useMemo içinde güncelle
    // In simulation mode, update buffer inside useMemo for render-cycle consistency
    const numericValues: Record<string, number> = {};
    let hasAny = false;
    for (const tag of tags) {
      const v = simTagValues[tag];
      if (typeof v === 'number') { numericValues[tag] = v; hasAny = true; }
    }

    if (hasAny) {
      const now = Date.now();
      simBufferRef.current.push({ t: now, values: numericValues });
      const cutoff = now - rangeMs;
      simBufferRef.current = simBufferRef.current.filter((p) => p.t >= cutoff);
    }

    return simBufferRef.current.length > 0
      ? [...simBufferRef.current]
      : generateDemoTraces(tags, 30);
  }, [isEditing, simulationMode, tags, simTagValues, rangeMs]);

  /* ---------- Layout ------------------------------------------------ */
  const PAD = 8;
  const innerW = width - PAD * 2;
  const innerH = height - PAD * 2;
  const TOOLBAR_H = 22;
  const LEGEND_H = showLegend ? 16 : 0;
  const ML = 40;
  const chartW = Math.max(innerW - ML - 10, 10);
  const MT = TOOLBAR_H + 4;
  const chartH = Math.max(innerH - MT - 20 - LEGEND_H, 10);

  /* ---------- Scales ----------------------------------------------- */
  const yDomain = useMemo(() => computeYDomain(chartData, tags), [chartData, tags]);
  const xDomain = useMemo(() => {
    if (chartData.length === 0) return { min: Date.now() - rangeMs, max: Date.now() };
    return { min: chartData[0].t, max: chartData[chartData.length - 1].t };
  }, [chartData, rangeMs]);

  const sx = useCallback((t: number) => ML + ((t - xDomain.min) / (xDomain.max - xDomain.min || 1)) * chartW, [xDomain, chartW]);
  const sy = useCallback((v: number) => MT + chartH - ((v - yDomain.min) / (yDomain.max - yDomain.min || 1)) * chartH, [yDomain, chartH]);

  /* ---------- Ticks ------------------------------------------------ */
  const yTicks = useMemo(() => {
    const step = niceStep(yDomain.max - yDomain.min, 4);
    const ticks: number[] = [];
    for (let v = Math.ceil(yDomain.min / step) * step; v <= yDomain.max; v += step) ticks.push(Math.round(v * 100) / 100);
    return ticks;
  }, [yDomain]);

  const xTicks = useMemo(() => {
    const cnt = Math.max(2, Math.min(6, Math.floor(chartW / 60)));
    const step = (xDomain.max - xDomain.min) / (cnt - 1);
    return Array.from({ length: cnt }, (_, i) => xDomain.min + i * step);
  }, [xDomain, chartW]);

  /* ---------- Polylines -------------------------------------------- */
  const polylines = useMemo(() => tags.map((tag) =>
    chartData.filter((pt) => pt.values[tag] !== undefined)
      .map((pt) => `${sx(pt.t).toFixed(1)},${sy(pt.values[tag]).toFixed(1)}`).join(' '),
  ), [tags, chartData, sx, sy]);

  /* ---------- Hover ------------------------------------------------ */
  const [hover, setHover] = useState<{ x: number; idx: number } | null>(null);

  const onMouseMove = useCallback((e: React.MouseEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const tAtMouse = xDomain.min + ((e.clientX - rect.left - ML) / chartW) * (xDomain.max - xDomain.min);
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < chartData.length; i++) {
      const d = Math.abs(chartData[i].t - tAtMouse);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (chartData.length > 0) setHover({ x: sx(chartData[best].t), idx: best });
  }, [chartData, xDomain, chartW, sx]);

  /* ---------- Render ----------------------------------------------- */
  const endX = ML + chartW;
  return (
    <div style={{ width, height, padding: PAD, boxSizing: 'border-box' }}>
      <svg width={innerW} height={innerH} style={{ display: 'block', overflow: 'visible' }}>
        {/* Toolbar */}
        <foreignObject x={0} y={0} width={innerW} height={TOOLBAR_H}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, height: TOOLBAR_H, fontSize: 10 }}>
            <span style={{ fontWeight: 600, color: '#374151', marginRight: 'auto', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
            {TIME_RANGES.map((r) => (
              <button key={r.key} onClick={() => setSelectedRange(r.key)} style={{
                padding: '1px 5px', fontSize: 9, border: '1px solid', lineHeight: '14px', borderRadius: 3, cursor: 'pointer',
                borderColor: selectedRange === r.key ? '#06b6d4' : '#d1d5db',
                background: selectedRange === r.key ? '#ecfeff' : '#fff',
                color: selectedRange === r.key ? '#0e7490' : '#6b7280',
              }}>{r.label}</button>
            ))}
            <button onClick={() => exportCsv(chartData, tags)} title="Export CSV" style={{
              padding: '1px 4px', fontSize: 9, border: '1px solid #d1d5db', background: '#fff',
              color: '#6b7280', borderRadius: 3, cursor: 'pointer', lineHeight: '14px',
            }}>CSV</button>
            {isEditing && <span style={{ fontSize: 8, color: '#9ca3af', fontStyle: 'italic' }}>demo</span>}
          </div>
        </foreignObject>

        {/* Grid */}
        {showGrid && yTicks.map((v) => <line key={`yg${v}`} x1={ML} y1={sy(v)} x2={endX} y2={sy(v)} stroke="#f3f4f6" strokeWidth={1} />)}
        {showGrid && xTicks.map((t, i) => <line key={`xg${i}`} x1={sx(t)} y1={MT} x2={sx(t)} y2={MT + chartH} stroke="#f3f4f6" strokeWidth={1} />)}

        {/* Axes */}
        <line x1={ML} y1={MT} x2={ML} y2={MT + chartH} stroke="#d1d5db" strokeWidth={1} />
        <line x1={ML} y1={MT + chartH} x2={endX} y2={MT + chartH} stroke="#d1d5db" strokeWidth={1} />

        {/* Y labels */}
        {yTicks.map((v) => <text key={`yl${v}`} x={ML - 4} y={sy(v) + 3} textAnchor="end" fontSize={8} fill="#9ca3af">{v % 1 === 0 ? v : v.toFixed(1)}</text>)}

        {/* X labels */}
        {xTicks.map((t, i) => <text key={`xl${i}`} x={sx(t)} y={MT + chartH + 14} textAnchor="middle" fontSize={8} fill="#9ca3af">{formatTimeLabel(t, rangeMs)}</text>)}

        {/* Data lines */}
        {polylines.map((pts, i) => pts ? (
          <polyline key={tags[i]} points={pts} fill="none" stroke={TRACE_COLORS[i % TRACE_COLORS.length]} strokeWidth={1.5} strokeLinejoin="round" />
        ) : null)}

        {/* No data */}
        {chartData.length === 0 && <text x={ML + chartW / 2} y={MT + chartH / 2} textAnchor="middle" fontSize={11} fill="#9ca3af">No trend data available</text>}

        {/* Hover rect */}
        <rect x={ML} y={MT} width={chartW} height={chartH} fill="transparent" onMouseMove={onMouseMove} onMouseLeave={() => setHover(null)} />

        {/* Hover tooltip */}
        {hover && chartData[hover.idx] && (<>
          <line x1={hover.x} y1={MT} x2={hover.x} y2={MT + chartH} stroke="#9ca3af" strokeWidth={0.5} strokeDasharray="3,2" />
          {tags.map((tag, i) => { const v = chartData[hover.idx].values[tag]; return v !== undefined ? <circle key={tag} cx={hover.x} cy={sy(v)} r={3} fill={TRACE_COLORS[i % TRACE_COLORS.length]} stroke="#fff" strokeWidth={1} /> : null; })}
          <foreignObject x={Math.min(hover.x + 8, ML + chartW - 100)} y={MT + 2} width={100} height={14 + tags.length * 12}>
            <div style={{ background: 'rgba(255,255,255,0.95)', border: '1px solid #e5e7eb', borderRadius: 3, padding: '2px 4px', fontSize: 8, lineHeight: '12px', pointerEvents: 'none' }}>
              <div style={{ color: '#6b7280' }}>{formatTimeLabel(chartData[hover.idx].t, rangeMs)}</div>
              {tags.map((tag, i) => { const v = chartData[hover.idx].values[tag]; return v !== undefined ? <div key={tag} style={{ color: TRACE_COLORS[i % TRACE_COLORS.length] }}>{tag}: {v.toFixed(2)}</div> : null; })}
            </div>
          </foreignObject>
        </>)}

        {/* Legend */}
        {showLegend && tags.length > 1 && (
          <foreignObject x={ML} y={innerH - LEGEND_H} width={chartW} height={LEGEND_H}>
            <div style={{ display: 'flex', gap: 8, fontSize: 8, color: '#6b7280' }}>
              {tags.map((tag, i) => (
                <span key={tag} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <span style={{ width: 8, height: 3, borderRadius: 1, background: TRACE_COLORS[i % TRACE_COLORS.length], display: 'inline-block' }} />{tag}
                </span>
              ))}
            </div>
          </foreignObject>
        )}
      </svg>
    </div>
  );
};

TrendChartRenderer.displayName = 'TrendChartRenderer';
export default memo(TrendChartRenderer);
