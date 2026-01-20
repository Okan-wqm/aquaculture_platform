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

import React, { useState, useEffect, useCallback, MouseEvent as ReactMouseEvent, useMemo } from 'react';
import { EdgeProps, useReactFlow } from 'reactflow';
import { getEdgeStyle, ConnectionType } from '../../config/connectionTypes';

/* -------------------------------------------------- */
/*  Types                                             */
/* -------------------------------------------------- */
type Point = { x: number; y: number };
type BendPoint = Point & { locked?: boolean };

interface OrthogonalEdgeData {
  bendPoints?: BendPoint[];
  label?: string;
  connectionType?: ConnectionType;
  routingMode?: 'horizontal-first' | 'vertical-first' | 'auto';
}

/* -------------------------------------------------- */
/*  Constants                                         */
/* -------------------------------------------------- */
const SNAP = 5;
const POINT_RADIUS = 5;
const POINT_RADIUS_HOVER = 8;
const HIT_AREA_WIDTH = 16;
const MIN_SEGMENT = 20; // Minimum segment length before adding bend

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
/**
 * Render arrow head at the end of the path, rotated based on last segment direction
 */
const renderArrow = (source: Point, target: Point, bends: BendPoint[], color: string = '#374151'): JSX.Element | null => {
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
export default function OrthogonalEdge(props: EdgeProps<OrthogonalEdgeData>) {
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

  const { setEdges } = useReactFlow();

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
  }, [source, target, bendPoints]);

  /* ---------- Persist changes ---------------------- */
  useEffect(() => {
    setEdges(edges =>
      edges.map(e =>
        e.id === id
          ? { ...e, data: { ...e.data, bendPoints } }
          : e
      )
    );
  }, [bendPoints, id, setEdges]);

  /* ---------- Drag handling ------------------------ */
  const handleMouseDown = useCallback((e: ReactMouseEvent<SVGCircleElement>, idx: number) => {
    e.stopPropagation();
    e.preventDefault();

    const startX = e.clientX;
    const startY = e.clientY;
    const { x: initX, y: initY } = bendPoints[idx];

    const onMove = (mv: globalThis.MouseEvent) => {
      const dx = mv.clientX - startX;
      const dy = mv.clientY - startY;

      // Snap to grid
      const newX = Math.round((initX + dx) / SNAP) * SNAP;
      const newY = Math.round((initY + dy) / SNAP) * SNAP;

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
  const handlePointRightClick = useCallback((e: ReactMouseEvent<SVGCircleElement>, idx: number) => {
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

      {/* Bend point controls */}
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
            onMouseDown={e => handleMouseDown(e as any, idx)}
            onContextMenu={e => handlePointRightClick(e as any, idx)}
            onMouseEnter={() => setHoveredPoint(idx)}
            onMouseLeave={() => setHoveredPoint(null)}
          />
        </g>
      ))}

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

      {/* Double-click hit area - rendered last for highest z-index over bend points */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={HIT_AREA_WIDTH}
        style={{ cursor: 'crosshair', pointerEvents: 'stroke' }}
        onDoubleClick={handlePathDoubleClick}
      />
    </g>
  );
}
