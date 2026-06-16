/**
 * DraggableEdge - Bezier Curve Edge with Draggable Control Point (SCADA Builder)
 *
 * Features:
 * - Quadratic Bezier curve (single control point)
 * - Optional Cubic Bezier (two control points)
 * - Draggable control point(s)
 * - Guide lines showing bezier control polygon (on selection)
 * - P&ID connection type styling (ISA-5.1 standard)
 * - Selection highlight with endpoint indicators
 * - Proper state persistence via EdgeStoreContext
 */

import { useState, useEffect, useCallback, useRef, MouseEvent as ReactMouseEvent } from 'react';
import { EdgeProps, type Edge } from '@xyflow/react';
import { getEdgeStyle, ConnectionType } from '../../../config/connectionTypes';
import { useEdgeStoreContext } from '../EdgeStoreContext';
import { useEdgeFlowState } from './useEdgeFlowState';
import type { EdgeFlowConfig } from '../../../types/scada-edge.types';

/* -------------------------------------------------- */
/*  Types                                             */
/* -------------------------------------------------- */
type ControlPoint = { x: number; y: number };

export interface DraggableEdgeData extends Record<string, unknown> {
  controlPoint?: ControlPoint;
  controlPoint2?: ControlPoint; // For cubic bezier
  curveType?: 'quadratic' | 'cubic';
  label?: string;
  connectionType?: ConnectionType;
  showGuides?: boolean;
  /** Tag-driven flow animation binding */
  flowConfig?: EdgeFlowConfig;
  /** Legacy static animation flag (backward compat) */
  animated?: boolean;
}

/* -------------------------------------------------- */
/*  Constants                                         */
/* -------------------------------------------------- */
const CONTROL_RADIUS = 8;
const CONTROL_RADIUS_HOVER = 10;

/** Evaluate a point on a quadratic Bezier at parameter t */
const quadBezier = (t: number, p0: number, p1: number, p2: number) =>
  (1 - t) * (1 - t) * p0 + 2 * (1 - t) * t * p1 + t * t * p2;

/** Evaluate a point on a cubic Bezier at parameter t */
const cubicBezier = (t: number, p0: number, p1: number, p2: number, p3: number) =>
  (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3;

/* -------------------------------------------------- */
/*  Component                                         */
/* -------------------------------------------------- */
const DraggableEdge: React.FC<EdgeProps<Edge<DraggableEdgeData>>> = (props) => {
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

  const { updateEdgeData } = useEdgeStoreContext();

  /* Tag-driven flow state (falls back to static animated flag) */
  const flowState = useEdgeFlowState(data?.flowConfig);
  const shouldAnimate = data?.flowConfig
    ? flowState.isFlowing
    : !!data?.animated;

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

  // Track whether user has manually dragged control points
  const userDraggedCP1 = useRef(!!data?.controlPoint);
  const userDraggedCP2 = useRef(!!data?.controlPoint2);

  /* ---------- Sync control points with node movement ------- */
  useEffect(() => {
    if (!userDraggedCP1.current) {
      setControlPoint({
        x: (sourceX + targetX) / 2 + 40,
        y: (sourceY + targetY) / 2 - 40,
      });
    }
    if (!userDraggedCP2.current) {
      setControlPoint2({
        x: (sourceX + targetX) / 2 - 40,
        y: (sourceY + targetY) / 2 + 40,
      });
    }
  }, [sourceX, sourceY, targetX, targetY]);

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
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
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

      const svg = (e.target as Element).closest('svg') as SVGSVGElement | null;
      if (!svg) return;

      // Mark this control point as user-customized
      if (cpIndex === 1) {
        userDraggedCP1.current = true;
      } else {
        userDraggedCP2.current = true;
      }

      const onMove = (mv: globalThis.MouseEvent) => {
        const ctm = svg.getScreenCTM()?.inverse();
        if (!ctm) return;

        const pt = svg.createSVGPoint();
        pt.x = mv.clientX;
        pt.y = mv.clientY;
        const svgPt = pt.matrixTransform(ctm);

        const newCP = { x: svgPt.x, y: svgPt.y };

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
    []
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

      {/* Main bezier curve with P&ID styling.
          Tag-driven flow applies inline dash animation per-edge. */}
      <path
        id={id}
        d={edgePath}
        className="react-flow__edge-path"
        fill="none"
        style={{
          pointerEvents: 'stroke',
          stroke: edgeStyle.stroke,
          strokeWidth: edgeStyle.strokeWidth,
          strokeDasharray: (data?.flowConfig && shouldAnimate)
            ? '8 4'
            : edgeStyle.strokeDasharray,
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
          style={{ pointerEvents: 'none' }}
        />
      )}

      {/* P&ID flow direction indicator -- only rendered when actively flowing */}
      {shouldAnimate && (() => {
        const T = 0.5;
        const DELTA = 0.01;
        let mx: number, my: number, angle: number;
        if (curveType === 'cubic') {
          mx = cubicBezier(T, sourceX, controlPoint.x, controlPoint2.x, targetX);
          my = cubicBezier(T, sourceY, controlPoint.y, controlPoint2.y, targetY);
          const nx = cubicBezier(T + DELTA, sourceX, controlPoint.x, controlPoint2.x, targetX);
          const ny = cubicBezier(T + DELTA, sourceY, controlPoint.y, controlPoint2.y, targetY);
          angle = Math.atan2(ny - my, nx - mx) * (180 / Math.PI);
        } else {
          mx = quadBezier(T, sourceX, controlPoint.x, targetX);
          my = quadBezier(T, sourceY, controlPoint.y, targetY);
          const nx = quadBezier(T + DELTA, sourceX, controlPoint.x, targetX);
          const ny = quadBezier(T + DELTA, sourceY, controlPoint.y, targetY);
          angle = Math.atan2(ny - my, nx - mx) * (180 / Math.PI);
        }
        return (
          <polygon
            points="-7,-5 0,0 -7,5"
            fill={edgeStyle.stroke}
            transform={`translate(${mx},${my}) rotate(${angle})`}
            style={{ pointerEvents: 'none' }}
          >
            <animate attributeName="opacity" values="1;0.2;1" dur="1.5s" repeatCount="indefinite" />
          </polygon>
        );
      })()}

      {/* Control point handles - only visible when selected */}
      {selected && (
        <>
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
          >
            <title>Kontrol noktasi 1 — surukle: egriyi ayarla</title>
          </circle>

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
            >
              <title>Kontrol noktasi 2 — surukle: egriyi ayarla</title>
            </circle>
          )}
        </>
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
