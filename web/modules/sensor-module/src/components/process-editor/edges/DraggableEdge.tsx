/**
 * DraggableEdge - Bezier Curve Edge with Draggable Control Point
 *
 * Features:
 * - Quadratic Bezier curve (single control point)
 * - Optional Cubic Bezier (two control points)
 * - Draggable control point(s)
 * - Guide lines showing bezier control polygon (on selection)
 * - P&ID connection type styling (ISA-5.1 standard)
 * - Selection highlight with endpoint indicators
 * - Proper state persistence via processStore
 */

import React, { useState, useEffect, useCallback, MouseEvent as ReactMouseEvent } from 'react';
import { EdgeProps } from 'reactflow';
import { getEdgeStyle, ConnectionType } from '../../../config/connectionTypes';
import { useProcessStore } from '../../../store/processStore';

/* -------------------------------------------------- */
/*  Types                                             */
/* -------------------------------------------------- */
type ControlPoint = { x: number; y: number };

export interface DraggableEdgeData {
  controlPoint?: ControlPoint;
  controlPoint2?: ControlPoint; // For cubic bezier
  curveType?: 'quadratic' | 'cubic';
  label?: string;
  connectionType?: ConnectionType;
  showGuides?: boolean;
}

/* -------------------------------------------------- */
/*  Constants                                         */
/* -------------------------------------------------- */
const CONTROL_RADIUS = 8;
const CONTROL_RADIUS_HOVER = 10;

/**
 * Render arrow head at the end of the Bezier curve, rotated based on tangent direction
 * For Quadratic: tangent at end is from control point to end
 * For Cubic: tangent at end is from second control point to end
 */
const renderArrow = (
  targetX: number,
  targetY: number,
  prevX: number,
  prevY: number,
  color: string = '#374151'
): JSX.Element => {
  const angle = Math.atan2(targetY - prevY, targetX - prevX) * (180 / Math.PI);
  return (
    <polygon
      points="0,-5 12,0 0,5"
      fill={color}
      transform={`translate(${targetX},${targetY}) rotate(${angle})`}
      style={{ pointerEvents: 'none' }}
    />
  );
};

/* -------------------------------------------------- */
/*  Component                                         */
/* -------------------------------------------------- */
const DraggableEdge: React.FC<EdgeProps<DraggableEdgeData>> = (props) => {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    markerEnd,
    style = {},
    data,
    selected,
  } = props;

  const updateEdgeData = useProcessStore((state) => state.updateEdgeData);

  const curveType = data?.curveType || 'quadratic';
  const showGuides = data?.showGuides ?? true;

  /* ---------- Get P&ID styling ----------------- */
  const connectionType = data?.connectionType || 'process-pipe';
  const edgeStyle = getEdgeStyle(connectionType);

  /* ---------- Control points -------------------- */
  const defaultCP1: ControlPoint = {
    x: (sourceX + targetX) / 2 + 40,
    y: (sourceY + targetY) / 2 - 40,
  };

  const defaultCP2: ControlPoint = {
    x: (sourceX + targetX) / 2 - 40,
    y: (sourceY + targetY) / 2 + 40,
  };

  const [controlPoint, setControlPoint] = useState<ControlPoint>(
    data?.controlPoint ?? defaultCP1
  );

  const [controlPoint2, setControlPoint2] = useState<ControlPoint>(
    data?.controlPoint2 ?? defaultCP2
  );

  const [hoveredCP, setHoveredCP] = useState<1 | 2 | null>(null);

  /* ---------- Build path ------------------------ */
  const [edgePath, setEdgePath] = useState<string>('');

  useEffect(() => {
    if (curveType === 'cubic') {
      // Cubic Bezier: M start C cp1 cp2 end
      setEdgePath(
        `M${sourceX},${sourceY} C${controlPoint.x},${controlPoint.y} ${controlPoint2.x},${controlPoint2.y} ${targetX},${targetY}`
      );
    } else {
      // Quadratic Bezier: M start Q cp end
      setEdgePath(
        `M${sourceX},${sourceY} Q${controlPoint.x},${controlPoint.y} ${targetX},${targetY}`
      );
    }
  }, [sourceX, sourceY, targetX, targetY, controlPoint, controlPoint2, curveType]);

  /* ---------- Persist changes via store --------- */
  useEffect(() => {
    const newData: Partial<DraggableEdgeData> = {
      controlPoint,
      ...(curveType === 'cubic' ? { controlPoint2 } : {}),
    };
    updateEdgeData(id, newData as any);
  }, [controlPoint, controlPoint2, id, curveType, updateEdgeData]);

  /* ---------- Drag handling --------------------- */
  const handleMouseDown = useCallback(
    (e: ReactMouseEvent<SVGCircleElement>, cpIndex: 1 | 2) => {
      e.stopPropagation();
      e.preventDefault();

      const startX = e.clientX;
      const startY = e.clientY;
      const cp = cpIndex === 1 ? controlPoint : controlPoint2;
      const { x: initX, y: initY } = cp;

      const onMove = (mv: globalThis.MouseEvent) => {
        const dx = mv.clientX - startX;
        const dy = mv.clientY - startY;
        const newCP = { x: initX + dx, y: initY + dy };

        if (cpIndex === 1) {
          setControlPoint(newCP);
        } else {
          setControlPoint2(newCP);
        }
      };

      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [controlPoint, controlPoint2]
  );

  /* ---------- Guide lines path ------------------ */
  const guidePath = curveType === 'cubic'
    ? `M${sourceX},${sourceY} L${controlPoint.x},${controlPoint.y} L${controlPoint2.x},${controlPoint2.y} L${targetX},${targetY}`
    : `M${sourceX},${sourceY} L${controlPoint.x},${controlPoint.y} L${targetX},${targetY}`;

  /* ---------- Render ---------------------------- */
  return (
    <g className="react-flow__edge-draggable">
      {/* Guide lines (control polygon) - only when selected */}
      {showGuides && selected && (
        <path
          d={guidePath}
          fill="none"
          stroke="#d1d5db"
          strokeWidth={1}
          strokeDasharray="4,3"
          style={{ pointerEvents: 'none' }}
        />
      )}

      {/* Main bezier curve with P&ID styling */}
      <path
        id={id}
        d={edgePath}
        className="react-flow__edge-path"
        fill="none"
        style={{
          pointerEvents: 'stroke',
          stroke: edgeStyle.stroke,
          strokeWidth: edgeStyle.strokeWidth,
          strokeDasharray: edgeStyle.strokeDasharray,
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
          style={{ pointerEvents: 'none' }}
        />
      )}

      {/* Custom arrow head - tangent direction based on curve type */}
      {curveType === 'cubic'
        ? renderArrow(targetX, targetY, controlPoint2.x, controlPoint2.y, edgeStyle.stroke)
        : renderArrow(targetX, targetY, controlPoint.x, controlPoint.y, edgeStyle.stroke)
      }

      {/* Control point 1 */}
      <circle
        cx={controlPoint.x}
        cy={controlPoint.y}
        r={hoveredCP === 1 ? CONTROL_RADIUS_HOVER : CONTROL_RADIUS}
        fill="#f97316"
        stroke="#ea580c"
        strokeWidth={2}
        style={{
          pointerEvents: 'all',
          cursor: 'grab',
          transition: 'r 0.1s ease-out',
        }}
        onMouseDown={(e) => handleMouseDown(e, 1)}
        onMouseEnter={() => setHoveredCP(1)}
        onMouseLeave={() => setHoveredCP(null)}
      />

      {/* Control point 2 (only for cubic) */}
      {curveType === 'cubic' && (
        <circle
          cx={controlPoint2.x}
          cy={controlPoint2.y}
          r={hoveredCP === 2 ? CONTROL_RADIUS_HOVER : CONTROL_RADIUS}
          fill="#8b5cf6"
          stroke="#7c3aed"
          strokeWidth={2}
          style={{
            pointerEvents: 'all',
            cursor: 'grab',
            transition: 'r 0.1s ease-out',
          }}
          onMouseDown={(e) => handleMouseDown(e, 2)}
          onMouseEnter={() => setHoveredCP(2)}
          onMouseLeave={() => setHoveredCP(null)}
        />
      )}

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

export default DraggableEdge;
