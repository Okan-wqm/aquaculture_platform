/**
 * MultiHandleEdge - Professional Polyline Edge with Draggable Control Points (SCADA Builder)
 *
 * Features:
 * - Multiple draggable waypoints (unlimited)
 * - First & last points locked to nodes
 * - Double-click on path segment to add new point
 * - Right-click on point to delete (non-locked only)
 * - Hover state with enlarged hit-area
 * - P&ID connection type styling (ISA-5.1 standard)
 * - Selection highlight with endpoint indicators
 * - 5px grid snapping
 * - Proper state persistence via EdgeStoreContext
 */

import { useState, useEffect, useCallback, useRef, MouseEvent as ReactMouseEvent } from 'react';
import { EdgeProps } from 'reactflow';
import { getEdgeStyle, ConnectionType } from '../../../config/connectionTypes';
import { useEdgeStoreContext } from '../EdgeStoreContext';
import { useEdgeFlowState } from './useEdgeFlowState';
import type { EdgeFlowConfig } from '../../../types/scada-edge.types';

/* -------------------------------------------------- */
/*  Types                                             */
/* -------------------------------------------------- */
type Point = { x: number; y: number; locked: boolean };

export interface MultiHandleEdgeData {
  points?: Point[];
  label?: string;
  connectionType?: ConnectionType;
  /** Tag-driven flow animation binding */
  flowConfig?: EdgeFlowConfig;
  /** Legacy static animation flag (backward compat) */
  animated?: boolean;
}

/* -------------------------------------------------- */
/*  Constants                                         */
/* -------------------------------------------------- */
const SNAP = 5;
const POINT_RADIUS = 5;
const POINT_RADIUS_HOVER = 8;
const HIT_AREA_WIDTH = 20;

/* -------------------------------------------------- */
/*  Utility Functions                                 */
/* -------------------------------------------------- */
const buildPath = (pts: Point[]): string => {
  if (pts.length < 2) return '';
  return pts
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`)
    .join(' ');
};

/**
 * Walk along a polyline to find position & tangent angle at a given fraction (0–1).
 */
const getPointOnPolyline = (
  pts: { x: number; y: number }[],
  fraction: number,
): { x: number; y: number; angle: number } => {
  if (pts.length < 2) return { x: pts[0]?.x ?? 0, y: pts[0]?.y ?? 0, angle: 0 };

  let totalLen = 0;
  const segLens: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const len = Math.sqrt((pts[i + 1].x - pts[i].x) ** 2 + (pts[i + 1].y - pts[i].y) ** 2);
    segLens.push(len);
    totalLen += len;
  }
  if (totalLen === 0) return { x: pts[0].x, y: pts[0].y, angle: 0 };

  let target = totalLen * fraction;
  for (let i = 0; i < segLens.length; i++) {
    if (target <= segLens[i] && segLens[i] > 0) {
      const t = target / segLens[i];
      return {
        x: pts[i].x + t * (pts[i + 1].x - pts[i].x),
        y: pts[i].y + t * (pts[i + 1].y - pts[i].y),
        angle: Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x) * (180 / Math.PI),
      };
    }
    target -= segLens[i];
  }
  const last = pts.length - 1;
  return {
    x: pts[last].x,
    y: pts[last].y,
    angle: Math.atan2(pts[last].y - pts[last - 1].y, pts[last].x - pts[last - 1].x) * (180 / Math.PI),
  };
};

/** P&ID style: animated flow-direction chevron on the line at 50% */
const renderFlowArrow = (pts: Point[], color: string = '#374151'): JSX.Element | null => {
  if (pts.length < 2) return null;
  const mid = getPointOnPolyline(pts, 0.5);
  return (
    <polygon
      points="-7,-5 0,0 -7,5"
      fill={color}
      transform={`translate(${mid.x},${mid.y}) rotate(${mid.angle})`}
      style={{ pointerEvents: 'none' }}
    >
      <animate attributeName="opacity" values="1;0.2;1" dur="1.5s" repeatCount="indefinite" />
    </polygon>
  );
};

/**
 * Find which segment of the path was clicked
 */
const findSegmentIndex = (pts: Point[], clickX: number, clickY: number): number => {
  let closestIdx = 0;
  let minDist = Infinity;

  for (let i = 0; i < pts.length - 1; i++) {
    const p1 = pts[i];
    const p2 = pts[i + 1];

    // Calculate distance from click point to line segment
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.sqrt(dx * dx + dy * dy);

    if (len === 0) continue;

    // Project click point onto segment
    let t = ((clickX - p1.x) * dx + (clickY - p1.y) * dy) / (len * len);
    t = Math.max(0, Math.min(1, t));

    const projX = p1.x + t * dx;
    const projY = p1.y + t * dy;
    const dist = Math.sqrt((clickX - projX) ** 2 + (clickY - projY) ** 2);

    if (dist < minDist) {
      minDist = dist;
      closestIdx = i;
    }
  }

  return closestIdx;
};

/* -------------------------------------------------- */
/*  Component                                         */
/* -------------------------------------------------- */
const MultiHandleEdge: React.FC<EdgeProps<MultiHandleEdgeData>> = (props) => {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    style = {},
    markerEnd,
    data,
    selected,
  } = props;

  const { updateEdgeData } = useEdgeStoreContext();
  const pathRef = useRef<SVGPathElement>(null);

  /* Tag-driven flow state (falls back to static animated flag) */
  const flowState = useEdgeFlowState(data?.flowConfig);
  const shouldAnimate = data?.flowConfig
    ? flowState.isFlowing
    : !!data?.animated;

  /* ---------- Initial points ----------------- */
  const initialPoints: Point[] =
    data?.points ?? [
      { x: sourceX, y: sourceY, locked: true },
      { x: (sourceX + targetX) / 2, y: sourceY, locked: false },
      { x: (sourceX + targetX) / 2, y: targetY, locked: false },
      { x: targetX, y: targetY, locked: true },
    ];

  const [points, setPoints] = useState<Point[]>(initialPoints);
  const [hoveredPoint, setHoveredPoint] = useState<number | null>(null);
  const [hoverSegment, setHoverSegment] = useState<{ x: number; y: number } | null>(null);
  const [edgePath, setEdgePath] = useState<string>('');

  /* ---------- Get P&ID styling ----------------- */
  const connectionType = data?.connectionType || 'process-pipe';
  const edgeStyle = getEdgeStyle(connectionType);

  /* ---------- Sync with source/target movement ------- */
  useEffect(() => {
    setPoints(prev => {
      const copy = [...prev];
      if (copy.length < 2) return copy;
      copy[0] = { ...copy[0], x: sourceX, y: sourceY };
      copy[copy.length - 1] = { ...copy[copy.length - 1], x: targetX, y: targetY };
      return copy;
    });
  }, [sourceX, sourceY, targetX, targetY]);

  /* ---------- Path update --------------------- */
  useEffect(() => {
    setEdgePath(buildPath(points));
  }, [points]);

  /* ---------- Persist changes via store ------- */
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    updateEdgeData(id, { points } as any);
  }, [points, id, updateEdgeData]);

  /* ---------- Drag handling ------------------------ */
  const handleMouseDown = useCallback((e: ReactMouseEvent<SVGCircleElement>, idx: number) => {
    e.stopPropagation();
    e.preventDefault();

    if (points[idx].locked) return;

    const svg = (e.target as SVGCircleElement).ownerSVGElement;
    if (!svg) return;

    // Convert initial mouse position to SVG space via CTM
    const toSVG = (clientX: number, clientY: number) => {
      const pt = svg.createSVGPoint();
      pt.x = clientX;
      pt.y = clientY;
      return pt.matrixTransform(svg.getScreenCTM()?.inverse());
    };

    const startSVG = toSVG(e.clientX, e.clientY);
    const { x: initX, y: initY } = points[idx];

    const onMove = (mv: globalThis.MouseEvent) => {
      const curSVG = toSVG(mv.clientX, mv.clientY);
      const dx = curSVG.x - startSVG.x;
      const dy = curSVG.y - startSVG.y;
      const newX = Math.round((initX + dx) / SNAP) * SNAP;
      const newY = Math.round((initY + dy) / SNAP) * SNAP;

      setPoints(prev => {
        const copy = [...prev];
        copy[idx] = { ...copy[idx], x: newX, y: newY };
        return copy;
      });
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [points]);

  /* ---------- Double-click to add point ------------ */
  const handlePathDoubleClick = useCallback((e: ReactMouseEvent<SVGPathElement>) => {
    e.stopPropagation();
    e.preventDefault();

    // Get SVG coordinates
    const svg = (e.target as SVGPathElement).ownerSVGElement;
    if (!svg) return;

    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const svgPoint = pt.matrixTransform(svg.getScreenCTM()?.inverse());

    const clickX = svgPoint.x;
    const clickY = svgPoint.y;

    // Find which segment was clicked
    const segmentIdx = findSegmentIndex(points, clickX, clickY);

    // Add new point after the segment start
    const newPoint: Point = {
      x: Math.round(clickX / SNAP) * SNAP,
      y: Math.round(clickY / SNAP) * SNAP,
      locked: false,
    };

    setPoints(prev => {
      const copy = [...prev];
      copy.splice(segmentIdx + 1, 0, newPoint);
      return copy;
    });
  }, [points]);

  /* ---------- Right-click to delete point ---------- */
  const handlePointRightClick = useCallback((e: ReactMouseEvent<SVGCircleElement>, idx: number) => {
    e.stopPropagation();
    e.preventDefault();

    // Cannot delete locked points (first and last)
    if (points[idx].locked) return;

    // Need at least 2 points (source and target)
    if (points.length <= 2) return;

    setPoints(prev => prev.filter((_, i) => i !== idx));
  }, [points]);

  /* ---------- Path hover for insertion preview ----- */
  const handlePathMouseMove = useCallback((e: ReactMouseEvent<SVGPathElement>) => {
    const svg = (e.target as SVGPathElement).ownerSVGElement;
    if (!svg) return;

    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const svgPoint = pt.matrixTransform(svg.getScreenCTM()?.inverse());

    setHoverSegment({ x: svgPoint.x, y: svgPoint.y });
  }, []);

  const handlePathMouseLeave = useCallback(() => {
    setHoverSegment(null);
  }, []);

  /* ---------- Render ------------------------------- */
  return (
    <g className="react-flow__edge-multihandle">
      {/* Combined hit area: hover preview + double-click to add point.
          Rendered BEFORE control points so draggable circles stay on top. */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={HIT_AREA_WIDTH}
        style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
        onMouseMove={handlePathMouseMove}
        onMouseLeave={handlePathMouseLeave}
        onDoubleClick={handlePathDoubleClick}
      />

      {/* Main visible path with P&ID styling.
          Tag-driven flow applies inline dash animation per-edge. */}
      <path
        ref={pathRef}
        id={id}
        d={edgePath}
        className="react-flow__edge-path"
        fill="none"
        style={{
          pointerEvents: 'none',
          stroke: edgeStyle.stroke,
          strokeWidth: edgeStyle.strokeWidth,
          strokeDasharray: (data?.flowConfig && shouldAnimate)
            ? '8 4'
            : edgeStyle.strokeDasharray,
          ...(data?.flowConfig && shouldAnimate ? {
            animation: `edge-flow ${flowState.speed}s linear infinite`,
            animationDirection: flowState.direction === 'reverse' ? 'reverse' : 'normal',
          } : {}),
          ...style,
        }}
      />

      {/* Selection highlight */}
      {selected && (
        <path
          d={edgePath}
          fill="none"
          stroke="#3b82f6"
          strokeWidth={(edgeStyle.strokeWidth || 2) + 4}
          strokeOpacity={0.3}
          style={{ pointerEvents: 'none' }}
        />
      )}

      {/* P&ID flow direction indicator -- only when actively flowing */}
      {shouldAnimate && renderFlowArrow(points, edgeStyle.stroke)}

      {/* Hover insertion preview */}
      {hoverSegment && (
        <circle
          cx={hoverSegment.x}
          cy={hoverSegment.y}
          r={4}
          fill="#10b981"
          fillOpacity={0.5}
          stroke="#10b981"
          strokeWidth={1}
          style={{ pointerEvents: 'none' }}
        />
      )}

      {/* Control points (visible only when selected) */}
      {selected && points.map((pt, idx) => (
        <circle
          key={idx}
          cx={pt.x}
          cy={pt.y}
          r={hoveredPoint === idx ? POINT_RADIUS_HOVER : POINT_RADIUS}
          fill={pt.locked ? '#6b7280' : '#f97316'}
          stroke={pt.locked ? '#374151' : '#ea580c'}
          strokeWidth={1.5}
          style={{
            pointerEvents: 'all',
            cursor: pt.locked ? 'not-allowed' : 'grab',
            transition: 'r 0.1s ease-out',
          }}
          onMouseDown={e => handleMouseDown(e, idx)}
          onContextMenu={e => handlePointRightClick(e, idx)}
          onMouseEnter={() => setHoveredPoint(idx)}
          onMouseLeave={() => setHoveredPoint(null)}
        >
          <title>{pt.locked ? 'Sabit nokta' : 'Surukle: tasima | Sag-tikla: sil'}</title>
        </circle>
      ))}

      {/* Endpoint indicators when selected */}
      {selected && (
        <>
          <circle
            cx={sourceX}
            cy={sourceY}
            r={4}
            fill="#22c55e"
            stroke="#16a34a"
            strokeWidth={1.5}
            style={{ pointerEvents: 'none' }}
          />
          <circle
            cx={targetX}
            cy={targetY}
            r={4}
            fill="#ef4444"
            stroke="#dc2626"
            strokeWidth={1.5}
            style={{ pointerEvents: 'none' }}
          />
        </>
      )}

      {/* Label */}
      {data?.label && (
        <text>
          <textPath
            href={`#${id}`}
            startOffset="50%"
            textAnchor="middle"
            style={{
              fontSize: 11,
              fill: '#374151',
              fontWeight: 500,
            }}
          >
            {data.label}
          </textPath>
        </text>
      )}

    </g>
  );
};

export default MultiHandleEdge;
