/**
 * One box of an architecture diagram: its frame (BoxFrame) and its text —
 * kicker naming the section it points to, title, description, example line
 * and pills — laid out as HTML inside a foreignObject so it wraps and scales
 * with the diagram's viewBox like the rest of the drawing.
 */
import React from 'react';

import { BoxFrame } from './BoxFrame';
import { DOC_PILL } from './docStyles';
import { HATCH_STRIPE } from './diagramStyles';
import type { DiagramBox } from './types';

export interface DiagramBoxShapeProps {
  box: DiagramBox;
  /** Id of the diagram's hatch pattern, used by the `hatch` kind */
  hatchPatternId: string;
}

export const DiagramBoxShape: React.FC<DiagramBoxShapeProps> = ({ box, hatchPatternId }) => (
  <g>
    <BoxFrame
      kind={box.kind}
      x={box.x}
      y={box.y}
      w={box.w}
      h={box.h}
      underlay={
        box.kind === 'hatch' ? (
          <rect x={box.x} y={box.y} width={box.w} height={box.h} fill={`url(#${hatchPatternId})`} />
        ) : null
      }
    />
    <foreignObject x={box.x} y={box.y} width={box.w} height={box.h}>
      <div
        className={`flex h-full flex-col gap-[3px] overflow-hidden px-3 pb-2.5 text-gray-900 dark:text-gray-100 ${box.kind === 'org' ? 'pt-[15px]' : 'pt-2.5'}`}
      >
        {box.ref ? (
          <span className="text-[11.5px] font-bold uppercase tracking-[0.1em] text-gray-600 dark:text-gray-400">
            {box.ref}
          </span>
        ) : null}
        <span className="font-display text-[19px] font-semibold leading-[1.08]">{box.title}</span>
        {box.sub ? (
          <span className="text-[13.5px] leading-[1.35] text-gray-700 dark:text-gray-300">
            {box.sub}
          </span>
        ) : null}
        {box.ex ? (
          <span className="font-display text-sm font-semibold tracking-[0.04em] text-primary-700 dark:text-primary-300">
            {box.ex}
          </span>
        ) : null}
        {box.pills.length > 0 ? (
          <span className="mt-auto flex flex-wrap gap-1">
            {box.pills.map((pill) => (
              <span key={pill} className={DOC_PILL}>
                {pill}
              </span>
            ))}
          </span>
        ) : null}
      </div>
    </foreignObject>
  </g>
);

/** The hatch of the `hatch` kind: 4-unit amber stripes on a 9-unit, 45° repeat. */
export const HatchPattern: React.FC<{ id: string }> = ({ id }) => (
  <pattern id={id} width={9} height={9} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <rect width={4} height={9} className={HATCH_STRIPE} />
  </pattern>
);
