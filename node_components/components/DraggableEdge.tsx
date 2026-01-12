/* ----------------------------------------------------------------
   src/components/DraggableEdge.tsx
   ----------------------------------------------------------------
   - Quadratic (Q) eğrisi, kontrol noktası sürüklenebilir
   - React Flow v12 uyumlu Edge bileşeni
----------------------------------------------------------------- */

import React, { useState, useEffect, MouseEvent } from 'react';
// import { EdgeProps, MarkerType } from '@xyflow/react';
import { EdgeProps, MarkerType } from 'reactflow';

type CP = { x: number; y: number };

export default function DraggableEdge(props: EdgeProps) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    markerEnd,
    style = {},
    data,
  } = props;

  /* ---------------- kontrol noktası ------------------------ */
  const [controlPoint, setControlPoint] = useState<CP>({
    x: (sourceX + targetX) / 2 + 50,
    y: (sourceY + targetY) / 2 - 50,
  });

  /* ---------------- path hesapla --------------------------- */
  const [edgePath, setEdgePath] = useState<string>('');
  useEffect(() => {
    setEdgePath(
      `M${sourceX},${sourceY} Q${controlPoint.x},${controlPoint.y} ${targetX},${targetY}`,
    );
  }, [sourceX, sourceY, targetX, targetY, controlPoint]);

  /* ---------------- drag handler --------------------------- */
  const handleMouseDown = (e: MouseEvent<SVGCircleElement>) => {
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;
    const { x: initX, y: initY } = controlPoint;

    const onMouseMove = (mv: MouseEvent | globalThis.MouseEvent) => {
      const dx = mv.clientX - startX;
      const dy = mv.clientY - startY;
      setControlPoint({ x: initX + dx, y: initY + dy });
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove as any);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove as any);
    window.addEventListener('mouseup', onMouseUp);
  };

  /* ---------------- render --------------------------------- */
  return (
    <>
      <path
        id={id}
        d={edgePath}
        className="react-flow__edge-path"
        style={{ pointerEvents: 'none', ...style }}
        markerEnd={markerEnd as MarkerType}
      />

      {/* draggable control point */}
      <circle
        cx={controlPoint.x}
        cy={controlPoint.y}
        r={8}
        fill="orange"
        stroke="black"
        strokeWidth={1.5}
        style={{ pointerEvents: 'all', cursor: 'grab' }}
        onMouseDown={handleMouseDown}
      />

      {/* opsiyonel etiket */}
      {data?.label && (
        <text>
          <textPath
            href={`#${id}`}
            startOffset="50%"
            style={{ fontSize: 12, fill: 'yellow' }}
          >
            {data.label}
          </textPath>
        </text>
      )}
    </>
  );
}

