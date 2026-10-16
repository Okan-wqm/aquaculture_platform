/**
 * The frame of one diagram box, drawn by kind: the paper, then an optional
 * underlay (the hatch pattern of a locked stretch), then the rule, and the
 * kind's mark — an asset's inner second rule, an organisation's heavy top
 * rule, a calculation's offset shadow. Shared by the diagrams and the legend
 * so a swatch is always the box it explains.
 */
import React from 'react';

import { ASSET_INNER_RULE, BOX_FRAME, BOX_PAPER, CALC_SHADOW, ORG_TOP_RULE } from './diagramStyles';
import type { BoxKind } from './types';

export interface BoxFrameProps {
  kind: BoxKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Painted between the paper and the rule (the hatch fill) */
  underlay?: React.ReactNode;
}

export const BoxFrame: React.FC<BoxFrameProps> = ({ kind, x, y, w, h, underlay }) => {
  const frame = BOX_FRAME[kind];
  return (
    <>
      {kind === 'calc' && <rect x={x + 4} y={y + 4} width={w} height={h} className={CALC_SHADOW} />}
      <rect x={x} y={y} width={w} height={h} className={frame.fill ?? BOX_PAPER} />
      {underlay}
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill="none"
        className={frame.stroke}
        strokeWidth={frame.strokeWidth}
        strokeDasharray={frame.dash}
      />
      {kind === 'asset' && (
        <rect
          x={x + 4}
          y={y + 4}
          width={Math.max(0, w - 8)}
          height={Math.max(0, h - 8)}
          fill="none"
          className={ASSET_INNER_RULE}
          strokeWidth={1}
        />
      )}
      {kind === 'org' && <rect x={x} y={y} width={w} height={5} className={ORG_TOP_RULE} />}
    </>
  );
};
