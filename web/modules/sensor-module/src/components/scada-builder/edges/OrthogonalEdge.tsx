/**
 * OrthogonalEdge - 90-Degree Angle Routing Edge (SCADA Builder)
 *
 * Features:
 * - Automatic orthogonal (90°) routing
 * - Horizontal-first or Vertical-first routing options
 * - Draggable bend points for manual adjustment
 * - P&ID connection type styling (ISA-5.1 standard)
 * - Smart routing to avoid overlaps
 * - Right-click on bend to delete
 * - Double-click on segment to add bend
 * - Proper state persistence via EdgeStoreContext
 */

import { type JSX, useState, useEffect, useCallback, MouseEvent as ReactMouseEvent, useMemo, useRef } from 'react';
import { EdgeProps, type Edge } from '@xyflow/react';
import { getEdgeStyle, ConnectionType } from '../../../config/connectionTypes';
import { useEdgeStoreContext } from '../EdgeStoreContext';
import { useEdgeFlowState } from './useEdgeFlowState';
import type { EdgeFlowConfig } from '../../../types/scada-edge.types';

/* -------------------------------------------------- */
/*  Types                                             */
/* -------------------------------------------------- */
type Point = { x: number; y: number };
type BendPoint = Point & { locked?: boolean };

export interface OrthogonalEdgeData extends Record<string, unknown> {
  bendPoints?: BendPoint[];
  label?: string;
  connectionType?: ConnectionType;
  routingMode?: 'horizontal-first' | 'vertical-first' | 'auto';
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
const HIT_AREA_WIDTH = 16;

/* -------------------------------------------------- */
/*  Utility Functions                                 */
/* -------------------------------------------------- */

/**
 * Calculate automatic orthogonal path between two points
 */
const calculateOrthogonalPath = (
  source: Point,
  target: Point,
  mode: 'horizontal-first' | 'vertical-first' | 'auto' = 'auto'
): BendPoint[] => {
  const dx = target.x - source.x;
  const dy = target.y - source.y;

  // Auto mode: choose based on direction
  const routeMode = mode === 'auto'
    ? (Math.abs(dx) >= Math.abs(dy) ? 'horizontal-first' : 'vertical-first')
    : mode;

  const midX = source.x + dx / 2;
  const midY = source.y + dy / 2;

  if (routeMode === 'horizontal-first') {
    // Go horizontal first, then vertical
    return [
      { x: midX, y: source.y },
      { x: midX, y: target.y },
    ];
  } else {
    // Go vertical first, then horizontal
    return [
      { x: source.x, y: midY },
      { x: target.x, y: midY },
    ];
  }
};

/**
 * Build SVG path from points with 90-degree corners
 */
const buildOrthogonalPath = (source: Point, target: Point, bends: BendPoint[]): string => {
  const allPoints = [source, ...bends, target];

  if (allPoints.length < 2) return '';

  let path = `M${allPoints[0].x},${allPoints[0].y}`;

  for (let i = 1; i < allPoints.length; i++) {
    const prev = allPoints[i - 1];
    const curr = allPoints[i];

    // Only horizontal or vertical lines
    if (Math.abs(prev.x - curr.x) < 1) {
      // Vertical line
      path += ` V${curr.y}`;
    } else if (Math.abs(prev.y - curr.y) < 1) {
      // Horizontal line
      path += ` H${curr.x}`;
    } else {
      // Mixed - create intermediate orthogonal step
      path += ` H${curr.x} V${curr.y}`;
    }
  }

  return path;
};

/**
 * Find segment index for a click position
 */
const findSegmentIndex = (
  source: Point,
  target: Point,
  bends: BendPoint[],
  clickX: number,
  clickY: number
): number => {
  const allPoints = [source, ...bends, target];
  let closestIdx = 0;
  let minDist = Infinity;

  for (let i = 0; i < allPoints.length - 1; i++) {
    const p1 = allPoints[i];
    const p2 = allPoints[i + 1];

    // For orthogonal lines, check distance to horizontal or vertical segment
    const isVertical = Math.abs(p1.x - p2.x) < 1;

    let dist: number;
    if (isVertical) {
      // Vertical segment
      const minY = Math.min(p1.y, p2.y);
      const maxY = Math.max(p1.y, p2.y);
      if (clickY >= minY && clickY <= maxY) {
        dist = Math.abs(clickX - p1.x);
      } else {
        dist = Infinity;
      }
    } else {
      // Horizontal segment
      const minX = Math.min(p1.x, p2.x);
      const maxX = Math.max(p1.x, p2.x);
      if (clickX >= minX && clickX <= maxX) {
        dist = Math.abs(clickY - p1.y);
      } else {
        dist = Infinity;
      }
    }

    if (dist < minDist) {
      minDist = dist;
      closestIdx = i;
    }
  }

  return closestIdx;
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
const renderFlowArrow = (source: Point, target: Point, bends: BendPoint[], color: string = '#374151'): JSX.Element | null => {
  const allPoints = [source, ...bends, target];
  if (allPoints.length < 2) return null;
  const mid = getPointOnPolyline(allPoints, 0.5);
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

/* -------------------------------------------------- */
/*  Component                                         */
/* -------------------------------------------------- */
const OrthogonalEdge: React.FC<EdgeProps<Edge<OrthogonalEdgeData>>> = (props) => {
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

  /**
   * Tag-driven flow state. When flowConfig is present, the animation
   * is controlled by the live tag value. When absent, we fall back
   * to the static `animated` flag (backward compatibility).
   */
  const flowState = useEdgeFlowState(data?.flowConfig);
  const shouldAnimate = data?.flowConfig
    ? flowState.isFlowing
    : !!data?.animated;

  const source: Point = { x: sourceX, y: sourceY };
  const target: Point = { x: targetX, y: targetY };

  const routingMode = data?.routingMode || 'auto';

  /* ---------- Initial bend points ----------------- */
  const initialBends: BendPoint[] = useMemo(() => {
    return data?.bendPoints ?? calculateOrthogonalPath(source, target, routingMode);
     
  }, []);

  const [bendPoints, setBendPoints] = useState<BendPoint[]>(initialBends);
  const [hoveredPoint, setHoveredPoint] = useState<number | null>(null);
  const [hoverPosition, setHoverPosition] = useState<Point | null>(null);

  /* ---------- Get P&ID styling ----------------- */
  const connectionType = data?.connectionType || 'process-pipe';
  const edgeStyle = getEdgeStyle(connectionType);

  /* ---------- Recalculate when endpoints move ------- */
  useEffect(() => {
    // If no custom bends, auto-calculate
    if (!data?.bendPoints || data.bendPoints.length === 0) {
      setBendPoints(calculateOrthogonalPath(source, target, routingMode));
    }
     
  }, [sourceX, sourceY, targetX, targetY, routingMode]);

  /* ---------- Build the path ----------------------- */
  const edgePath = useMemo(() => {
    return buildOrthogonalPath(source, target, bendPoints);
  }, [sourceX, sourceY, targetX, targetY, bendPoints]);

  /* ---------- Persist changes via store ------------ */
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    updateEdgeData(id, { bendPoints } as any);
  }, [bendPoints, id, updateEdgeData]);

  /* ---------- Drag handling ------------------------ */
  const handleMouseDown = useCallback((e: ReactMouseEvent<SVGRectElement>, idx: number) => {
    e.stopPropagation();
    e.preventDefault();

    const svg = (e.target as Element).closest('svg') as SVGSVGElement | null;
    if (!svg) return;

    const onMove = (mv: globalThis.MouseEvent) => {
      const ctm = svg.getScreenCTM()?.inverse();
      if (!ctm) return;

      const pt = svg.createSVGPoint();
      pt.x = mv.clientX;
      pt.y = mv.clientY;
      const svgPt = pt.matrixTransform(ctm);

      // Snap to grid
      const newX = Math.round(svgPt.x / SNAP) * SNAP;
      const newY = Math.round(svgPt.y / SNAP) * SNAP;

      setBendPoints(prev => {
        const copy = [...prev];
        copy[idx] = { x: newX, y: newY };
        return copy;
      });
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [bendPoints]);

  /* ---------- Double-click to add bend ------------ */
  const handlePathDoubleClick = useCallback((e: ReactMouseEvent<SVGPathElement>) => {
    e.stopPropagation();
    e.preventDefault();

    const svg = (e.target as SVGPathElement).ownerSVGElement;
    if (!svg) return;

    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const svgPoint = pt.matrixTransform(svg.getScreenCTM()?.inverse());

    const clickX = Math.round(svgPoint.x / SNAP) * SNAP;
    const clickY = Math.round(svgPoint.y / SNAP) * SNAP;

    // Find segment and add new bend
    const segmentIdx = findSegmentIndex(source, target, bendPoints, clickX, clickY);

    const newBend: BendPoint = { x: clickX, y: clickY };

    setBendPoints(prev => {
      const copy = [...prev];
      copy.splice(segmentIdx, 0, newBend);
      return copy;
    });
  }, [bendPoints, source, target]);

  /* ---------- Right-click to delete bend ---------- */
  const handlePointRightClick = useCallback((e: ReactMouseEvent<SVGRectElement>, idx: number) => {
    e.stopPropagation();
    e.preventDefault();

    // Keep at least some bends for orthogonal routing
    if (bendPoints.length <= 1) return;

    setBendPoints(prev => prev.filter((_, i) => i !== idx));
  }, [bendPoints]);

  /* ---------- Path hover for insertion preview ----- */
  const handlePathMouseMove = useCallback((e: ReactMouseEvent<SVGPathElement>) => {
    const svg = (e.target as SVGPathElement).ownerSVGElement;
    if (!svg) return;

    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const svgPoint = pt.matrixTransform(svg.getScreenCTM()?.inverse());

    setHoverPosition({ x: svgPoint.x, y: svgPoint.y });
  }, []);

  const handlePathMouseLeave = useCallback(() => {
    setHoverPosition(null);
  }, []);

  /* ---------- Render ------------------------------- */
  return (
    <g className="react-flow__edge-orthogonal">
      {/* Combined hit area: hover preview + double-click to add bend.
          Rendered BEFORE bend point controls so draggable rects stay on top. */}
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
          When tag-driven flow is active (flowConfig present), apply inline
          dash animation so each edge animates independently based on its
          bound tag. The animation speed and direction come from useEdgeFlowState. */}
      <path
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
          strokeLinejoin: 'miter',
          strokeLinecap: 'round',
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
          strokeLinejoin="round"
          style={{ pointerEvents: 'none' }}
        />
      )}

      {/* P&ID flow direction indicator -- animated chevron at path midpoint.
          Only rendered when the edge is actively flowing (tag-driven or legacy). */}
      {shouldAnimate && renderFlowArrow(source, target, bendPoints, edgeStyle.stroke)}

      {/* Hover insertion preview */}
      {hoverPosition && (
        <circle
          cx={hoverPosition.x}
          cy={hoverPosition.y}
          r={4}
          fill="#10b981"
          fillOpacity={0.5}
          stroke="#10b981"
          strokeWidth={1}
          style={{ pointerEvents: 'none' }}
        />
      )}

      {/* Bend point controls (squares for orthogonal) */}
      {bendPoints.map((pt, idx) => (
        <rect
          key={idx}
          x={pt.x - (hoveredPoint === idx ? POINT_RADIUS_HOVER : POINT_RADIUS)}
          y={pt.y - (hoveredPoint === idx ? POINT_RADIUS_HOVER : POINT_RADIUS)}
          width={(hoveredPoint === idx ? POINT_RADIUS_HOVER : POINT_RADIUS) * 2}
          height={(hoveredPoint === idx ? POINT_RADIUS_HOVER : POINT_RADIUS) * 2}
          rx={2}
          fill="#8b5cf6"
          stroke="#7c3aed"
          strokeWidth={1.5}
          style={{
            pointerEvents: 'all',
            cursor: 'grab',
            transition: 'all 0.1s ease-out',
          }}
          onMouseDown={(e) => handleMouseDown(e, idx)}
          onContextMenu={(e) => handlePointRightClick(e, idx)}
          onMouseEnter={() => setHoveredPoint(idx)}
          onMouseLeave={() => setHoveredPoint(null)}
        >
          <title>Surukle: tasima | Sag-tikla: sil</title>
        </rect>
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

export default OrthogonalEdge;
