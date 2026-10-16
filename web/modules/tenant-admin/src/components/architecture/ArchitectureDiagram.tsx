/**
 * One section's diagram, drawn from its content as SVG in the console's
 * blueprint frame.
 *
 * The canvas keeps the design's fixed coordinates in a viewBox, so the
 * drawing scales to the frame instead of being re-measured: full size on a
 * wide screen and never below 720 units wide, where the frame scrolls
 * sideways instead — on a phone the boxes stay legible rather than shrinking
 * to a third of their size.
 */
import React, { useId, useMemo } from 'react';
import { useI18n } from '@aquaculture/shared-ui';

import { DiagramBoxShape, HatchPattern } from './DiagramBoxShape';
import { routeSection } from './diagramGeometry';
import { DiagramGroupFrame, DiagramLinkLabel, DiagramLinkLayers } from './DiagramLinks';
import { DOCUMENT_LANGUAGE } from './content/language';
import { DOC_FRAME } from './docStyles';
import type { ArchitectureSection } from './types';

export const ArchitectureDiagram: React.FC<{ section: ArchitectureSection }> = ({ section }) => {
  const { t } = useI18n();
  // useId() is unique per instance but may carry characters a url(#…) paint
  // reference does not accept; the pattern id keeps only the safe ones.
  const hatchPatternId = `hatch-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  const routed = useMemo(() => routeSection(section), [section]);

  return (
    <div className={`${DOC_FRAME} overflow-x-auto p-5`}>
      <svg
        role="group"
        aria-label={t('architecture.diagram', { num: section.num })}
        viewBox={`0 0 ${section.width} ${section.height}`}
        className="block h-auto w-full min-w-[720px] max-w-[1170px] overflow-visible"
      >
        <defs>
          <HatchPattern id={hatchPatternId} />
        </defs>
        <g lang={DOCUMENT_LANGUAGE}>
          {(section.groups ?? []).map((group) => (
            <DiagramGroupFrame key={`${group.x}-${group.y}-${group.label}`} group={group} />
          ))}
          <DiagramLinkLayers layers={routed.layers} />
          {section.boxes.map((box) => (
            <DiagramBoxShape key={box.id} box={box} hatchPatternId={hatchPatternId} />
          ))}
          {routed.labels.map((label) => (
            <DiagramLinkLabel key={`${label.x}-${label.y}-${label.text}`} label={label} />
          ))}
        </g>
      </svg>
    </div>
  );
};
