/* ----------------------------------------------------------------
   src/components/MultiHandleEdge.tsx
   ----------------------------------------------------------------
   - Çok noktadan (polyline) oluşan sürüklenebilir kenar
   - İlk & son noktalar node’a kilitli, orta noktalar mouse ile taşınabilir
   - TypeScript ve React-Flow v12 uyumlu
----------------------------------------------------------------- */

import React, { useState, useEffect, MouseEvent } from 'react';
// import { EdgeProps, MarkerType } from '@xyflow/react';
import { EdgeProps, MarkerType } from 'reactflow';

/* -------------------------------------------------- */
/*  Yardımcı tipler                                   */
/* -------------------------------------------------- */
type Point = { x: number; y: number; locked: boolean };

/* -------------------------------------------------- */
/*  Yardımcı fonksiyonlar                             */
/* -------------------------------------------------- */
const buildPath = (pts: Point[]): string => {
  if (pts.length < 2) return '';
  return pts
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`)
    .join(' ');
};

const SNAP = 5;

/* -------------------------------------------------- */
/*  Bileşen                                           */
/* -------------------------------------------------- */
export default function MultiHandleEdge(props: EdgeProps) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    style = {},
    markerEnd,
    data,
  } = props;

  /* ---------- başlangıç noktaları ----------------- */
  const initialPoints: Point[] =
    data?.points ??
    [
      { x: sourceX, y: sourceY, locked: true },
      { x: (sourceX + targetX) / 2, y: sourceY, locked: false },
      { x: (sourceX + targetX) / 2, y: targetY, locked: false },
      { x: targetX, y: targetY, locked: true },
    ];

  const [points, setPoints] = useState<Point[]>(initialPoints);

  /* ---------- source / target hareket edince ------- */
  useEffect(() => {
    setPoints(prev => {
      const copy = [...prev];
      if (copy.length < 2) return copy;
      copy[0]               = { ...copy[0], x: sourceX, y: sourceY };
      copy[copy.length - 1] = { ...copy[copy.length - 1], x: targetX, y: targetY };
      return copy;
    });
  }, [sourceX, sourceY, targetX, targetY]);

  /* ---------- path & data sync --------------------- */
  const [edgePath, setEdgePath] = useState<string>('');
  useEffect(() => {
    setEdgePath(buildPath(points));
    if (data) data.points = points;          // save-friendly
  }, [points, data]);

  /* ---------- sürükleme ---------------------------- */
  const handleMouseDown = (e: MouseEvent<SVGCircleElement>, idx: number) => {
    e.stopPropagation();
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
  };

  /* ---------- render ------------------------------- */
  return (
    <>
      <path
        id={id}
        d={edgePath}
        className="react-flow__edge-path"
        style={{ pointerEvents: 'none', ...style }}
        markerEnd={markerEnd as MarkerType}
      />

      {/* kontrol noktaları */}
      {points.map((pt, idx) => (
        <circle
          key={idx}
          cx={pt.x}
          cy={pt.y}
          r={5}
          fill={pt.locked ? 'gray' : 'orange'}
          stroke="black"
          strokeWidth={1}
          style={{
            pointerEvents: 'all',
            cursor: pt.locked ? 'not-allowed' : 'grab',
          }}
          onMouseDown={e => handleMouseDown(e, idx)}
        />
      ))}

      {/* etiket */}
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

