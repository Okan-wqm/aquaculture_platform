/**
 * OrthogonalEdge - 90-Degree Angle Routing Edge
 *
 * Features:
 * - Automatic orthogonal (90°) routing
 * - Horizontal-first or Vertical-first routing options
 * - Draggable bend points for manual adjustment
 * - P&ID connection type styling (ISA-5.1 standard)
 * - Smart routing to avoid overlaps
 * - Right-click on bend to delete
 * - Double-click on segment to add bend
 */

import { EdgeProps, Position, useReactFlow, type Edge } from '@xyflow/react';
import { type JSX, useState, useEffect, useCallback, MouseEvent as ReactMouseEvent, useMemo } from 'react';

import { getEdgeStyle, ConnectionType } from '../config/connectionTypes';

/**
 * Optional persistence callback signature. When a consumer maintains
 * edge state outside ReactFlow's own edge list (e.g. a zustand store
 * backing SCADA process graphs), it passes its own update function
 * here; the lib edge will call it instead of ReactFlow's setEdges.
 * Defaults to ReactFlow's native state when omitted.
 */
export type EdgeDataUpdater<TData> = (id: string, data: Partial<TData>) => void;

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
}

export interface OrthogonalEdgeProps extends EdgeProps<Edge<OrthogonalEdgeData>> {
  /**
   * Optional persistence callback — see {@link EdgeDataUpdater}.
   * When omitted, the component persists bend-point changes via
   * ReactFlow's native setEdges.
   */
  updateEdgeData?: EdgeDataUpdater<OrthogonalEdgeData>;
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
 * Render arrow head at the end of the path, rotated based on last segment direction
 */
const renderArrow = (source: Point, target: Point, bends: BendPoint[], color = '#374151'): JSX.Element | null => {
  const allPoints = [source, ...bends, target];
  if (allPoints.length < 2) return null;
  const end = allPoints[allPoints.length - 1];
  const prev = allPoints[allPoints.length - 2];
  const angle = Math.atan2(end.y - prev.y, end.x - prev.x) * (180 / Math.PI);
  return (
    <polygon
      points="0,-5 12,0 0,5"
      fill={color}
      transform={`translate(${end.x},${end.y}) rotate(${angle})`}
      style={{ pointerEvents: 'none' }}
    />
  );
};

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

/* -------------------------------------------------- */
/*  Component                                         */
/* -------------------------------------------------- */
export default function OrthogonalEdge(props: OrthogonalEdgeProps) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    style = {},
    data,
    selected,
    updateEdgeData: externalUpdater,
  } = props;

  const { setEdges } = useReactFlow();

  // Unified persistence: prefer the consumer's updater when provided
  // (e.g. sensor-module's zustand processStore); fall back to
  // ReactFlow's native edges state otherwise. This lets the lib edge
  // live in both ReactFlow-native and store-backed consumer contexts
  // without forking the component.
  const persistBendPoints = useCallback(
    (nextBends: BendPoint[]) => {
      if (externalUpdater) {
        externalUpdater(id, { bendPoints: nextBends });
        return;
      }
      setEdges((edges) =>
        edges.map((e) =>
          e.id === id
            ? { ...e, data: { ...e.data, bendPoints: nextBends } }
            : e,
        ),
      );
    },
    [id, setEdges, externalUpdater],
  );

  // Apply handle offset correction to center edges on handle dots
  const HANDLE_OFFSET = 6; // half of 12px handle

  let sx = sourceX, sy = sourceY;
  if (sourcePosition === Position.Left)   sx += HANDLE_OFFSET;
  if (sourcePosition === Position.Right)  sx -= HANDLE_OFFSET;
  if (sourcePosition === Position.Top)    sy += HANDLE_OFFSET;
  if (sourcePosition === Position.Bottom) sy -= HANDLE_OFFSET;

  let tx = targetX, ty = targetY;
  if (targetPosition === Position.Left)   tx += HANDLE_OFFSET;
  if (targetPosition === Position.Right)  tx -= HANDLE_OFFSET;
  if (targetPosition === Position.Top)    ty += HANDLE_OFFSET;
  if (targetPosition === Position.Bottom) ty -= HANDLE_OFFSET;

  const source: Point = { x: sx, y: sy };
  const target: Point = { x: tx, y: ty };

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
  }, [source, target, bendPoints]);

  /* ---------- Persist changes ---------------------- */
  useEffect(() => {
    persistBendPoints(bendPoints);
  }, [bendPoints, persistBendPoints]);

  /* ---------- Drag handling ------------------------ */
  const handleMouseDown = useCallback((e: ReactMouseEvent<SVGRectElement>, idx: number) => {
    e.stopPropagation();
    e.preventDefault();

    // Get the SVG element for coordinate conversion (handles zoom/pan)
    const svg = (e.target as SVGElement).ownerSVGElement;
    if (!svg) return;

    const onMove = (mv: globalThis.MouseEvent) => {
      const pt = svg.createSVGPoint();
      pt.x = mv.clientX;
      pt.y = mv.clientY;
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      const svgPoint = pt.matrixTransform(ctm.inverse());

      // Snap to grid
      const newX = Math.round(svgPoint.x / SNAP) * SNAP;
      const newY = Math.round(svgPoint.y / SNAP) * SNAP;

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
      {/* Invisible hit area for hover preview */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={HIT_AREA_WIDTH}
        style={{ cursor: 'pointer' }}
        onMouseMove={handlePathMouseMove}
        onMouseLeave={handlePathMouseLeave}
      />

      {/* Main visible path with P&ID styling */}
      <path
        id={id}
        d={edgePath}
        className="react-flow__edge-path"
        fill="none"
        style={{
          pointerEvents: 'none',
          stroke: edgeStyle.stroke,
          strokeWidth: edgeStyle.strokeWidth,
          strokeDasharray: edgeStyle.strokeDasharray,
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
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

      {/* Custom arrow head - rotates based on last segment direction */}
      {renderArrow(source, target, bendPoints, edgeStyle.stroke)}

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

      {/* Double-click hit area - rendered BEFORE bend points so points stay on top */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={HIT_AREA_WIDTH}
        style={{ cursor: 'crosshair', pointerEvents: 'stroke' }}
        onDoubleClick={handlePathDoubleClick}
      />

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

      {/* Bend point controls - rendered LAST so they're on top and draggable */}
      {bendPoints.map((pt, idx) => (
        <g key={idx}>
          {/* Corner indicator (square for orthogonal) */}
          <rect
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
            onMouseDown={e => handleMouseDown(e, idx)}
            onContextMenu={e => handlePointRightClick(e, idx)}
            onMouseEnter={() => setHoveredPoint(idx)}
            onMouseLeave={() => setHoveredPoint(null)}
          />
        </g>
      ))}
    </g>
  );
}
