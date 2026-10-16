/**
 * The drawn connections of a diagram: the four link layers (one line path
 * and one arrowhead path per kind, from diagramGeometry), the link labels on
 * the page background, and the labelled dashed frames that group boxes.
 */
import React from 'react';

import { LINK_KINDS, type LinkLabel, type RoutedSection } from './diagramGeometry';
import { LABEL_TEXT, LINK_STYLE } from './diagramStyles';
import type { DiagramGroup } from './types';

export const DiagramLinkLayers: React.FC<{ layers: RoutedSection['layers'] }> = ({ layers }) => (
  <g aria-hidden="true">
    {LINK_KINDS.filter((kind) => layers[kind].line !== '').map((kind) => {
      const style = LINK_STYLE[kind];
      return (
        <g key={kind}>
          <path
            d={layers[kind].line}
            fill="none"
            className={style.line}
            strokeWidth={style.strokeWidth}
            strokeDasharray={style.dash}
            strokeLinecap={style.roundCaps ? 'round' : undefined}
          />
          <path d={layers[kind].heads} className={style.head} />
        </g>
      );
    })}
  </g>
);

/**
 * WHY an estimated width: a foreignObject needs one, and the label is centred
 * in it with visible overflow — so the estimate only has to be in the right
 * range for the label to sit centred on its point.
 */
const labelWidth = (text: string): number => text.length * 9 + 24;

export const DiagramLinkLabel: React.FC<{ label: LinkLabel }> = ({ label }) => {
  const width = labelWidth(label.text);
  return (
    <foreignObject
      x={label.x - width / 2}
      y={label.y - 12}
      width={width}
      height={24}
      className="overflow-visible"
    >
      <div className="flex h-full items-center justify-center">
        <span
          className={`whitespace-nowrap bg-white px-1.5 text-[13px] font-semibold leading-tight dark:bg-gray-900 ${label.dated ? 'border border-primary-500 text-primary-800 dark:text-primary-200' : LABEL_TEXT[label.kind]}`}
        >
          {label.text}
        </span>
      </div>
    </foreignObject>
  );
};

export const DiagramGroupFrame: React.FC<{ group: DiagramGroup }> = ({ group }) => (
  <g>
    <rect
      x={group.x}
      y={group.y}
      width={group.w}
      height={group.h}
      className="fill-gray-900/[0.025] stroke-gray-400 dark:fill-gray-100/[0.03] dark:stroke-gray-600"
      strokeWidth={1}
      strokeDasharray="4 3"
    />
    <foreignObject
      x={group.x + 12}
      y={group.y - 10}
      width={Math.max(0, group.w - 24)}
      height={20}
      className="overflow-visible"
    >
      <div className="flex h-full items-center">
        <span className="whitespace-nowrap bg-white px-2 text-xs font-bold uppercase tracking-[0.1em] text-gray-600 dark:bg-gray-900 dark:text-gray-400">
          {group.label}
        </span>
      </div>
    </foreignObject>
  </g>
);
