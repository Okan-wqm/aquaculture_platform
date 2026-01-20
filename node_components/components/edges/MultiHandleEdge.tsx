/**
 * MultiHandleEdge - Professional Polyline Edge with Draggable Control Points
 *
 * Features:
 * - Multiple draggable waypoints (unlimited)
 * - First & last points locked to nodes
 * - Double-click on path segment to add new point
 * - Right-click on point to delete (non-locked only)
 * - Hover state with enlarged hit-area
 * - P&ID connection type styling (ISA-5.1 standard)
 * - 5px grid snapping
 */

import React, { useState, useEffect, useCallback, MouseEvent as ReactMouseEvent, useRef } from 'react';
import { EdgeProps, useReactFlow } from 'reactflow';
import { getEdgeStyle, ConnectionType } from '../../config/connectionTypes';

/* -------------------------------------------------- */
/*  Types                                             */
/* -------------------------------------------------- */
type Point = { x: number; y: number; locked: boolean };

interface MultiHandleEdgeData {
  points?: Point[];
  label?: string;
  connectionType?: ConnectionType;
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
 * Render arrow head at the end of the path, rotated based on last segment direction
 */
const renderArrow = (pts: Point[], color: string = '#374151'): JSX.Element | null => {
  if (pts.length < 2) return null;
  const end = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
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
export default function MultiHandleEdge(props: EdgeProps<MultiHandleEdgeData>) {
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
  const pathRef = useRef<SVGPathElement>(null);

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

  /* ---------- Path & data sync --------------------- */
  useEffect(() => {
    setEdgePath(buildPath(points));

    // Persist points to edge data via setEdges
    setEdges(edges =>
      edges.map(e =>
        e.id === id
          ? { ...e, data: { ...e.data, points } }
          : e
      )
    );
  }, [points, id, setEdges]);

  /* ---------- Drag handling ------------------------ */
  const handleMouseDown = useCallback((e: ReactMouseEvent<SVGCircleElement>, idx: number) => {
    e.stopPropagation();
    e.preventDefault();

    if (points[idx].locked) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const { x: initX, y: initY } = points[idx];

    const onMove = (mv: globalThis.MouseEvent) => {
      const dx = mv.clientX - startX;
      const dy = mv.clientY - startY;
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
        ref={pathRef}
        id={id}
        d={edgePath}
        className="react-flow__edge-path"
        fill="none"
        style={{
          pointerEvents: 'none',
          stroke: edgeStyle.stroke,
          strokeWidth: edgeStyle.strokeWidth,
          strokeDasharray: edgeStyle.strokeDasharray,
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

      {/* Custom arrow head - rotates based on last segment direction */}
      {renderArrow(points, edgeStyle.stroke)}

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

      {/* Control points */}
      {points.map((pt, idx) => (
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
        />
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

      {/* Double-click hit area - rendered last for highest z-index over control points */}
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
