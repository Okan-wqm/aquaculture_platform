/**
 * SYSTEM-card model (P4b, mock). A system = a loop whose ordered water flow auto-includes
 * ALL members (every tank + pond + cage) + the biofilter + the dosing-inlet reference.
 * Chemical dosing is ONE recipe for the whole shared-water system, computed at the
 * biofilter inlet (`dosingReferenceStageId`). Each stage reuses the point-card's auto-bind
 * so its own realtime/manual sources drive its chart independently.
 *
 * The ordered `flow` is the seam a future per-system mass-balance will walk (feed→CO2,
 * equipment performance, inter-stage sensor deltas) — built now, computed nothing yet.
 */
import { LOOPS, SPECIES_TEMPLATES, TANKS } from './mock/fixtures';
import type { CardScope, WcFlowStage, WcSystemCard } from './types';
import { createCard } from './useWcCards';

function newId(systemId: string): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `sys-${systemId}`;
}

/** Ordered flow: dosing-inlet → biofilter → each system member (tanks). All enabled by default. */
export function buildSystemFlow(systemId: string, speciesTemplateId: string): WcFlowStage[] {
  const biofilterScope: CardScope = { kind: 'biofilter', id: systemId };
  const stages: WcFlowStage[] = [
    {
      id: `${systemId}::dosing-inlet`,
      kind: 'dosing-inlet',
      label: 'Dosing inlet (biofilter front)',
      scope: biofilterScope,
      paramSources: createCard(biofilterScope, speciesTemplateId).paramSources,
      enabled: true,
    },
    {
      id: `${systemId}::biofilter`,
      kind: 'biofilter',
      label: 'Biofilter',
      scope: biofilterScope,
      paramSources: createCard(biofilterScope, speciesTemplateId).paramSources,
      enabled: true,
    },
  ];
  for (const t of TANKS.filter((tank) => tank.loopId === systemId)) {
    const scope: CardScope = { kind: 'tank', id: t.id };
    stages.push({
      id: `${systemId}::${t.id}`,
      kind: 'tank',
      label: t.name,
      scope,
      paramSources: createCard(scope, speciesTemplateId).paramSources,
      enabled: true,
    });
  }
  return stages;
}

/** Build a default system card for a loop — auto-includes every member, dosing at the inlet. */
export function createSystemCard(systemId: string, speciesTemplateId = 'salmon_freshwater'): WcSystemCard {
  const loop = LOOPS.find((l) => l.id === systemId);
  const species = SPECIES_TEMPLATES.find((s) => s.id === speciesTemplateId) ?? SPECIES_TEMPLATES[0];
  const flow = buildSystemFlow(systemId, species.id);
  const dosingRef = flow.find((s) => s.kind === 'dosing-inlet') ?? flow[0];
  return {
    id: newId(systemId),
    kind: 'system',
    title: loop?.name ?? systemId,
    systemId,
    flow,
    activeStageId: flow[0].id,
    dosingReferenceStageId: dosingRef.id,
    shared: {
      limits: { ...species.limits },
      selectedReagents: ['Sodium Bicarbonate', 'Sodium Hydroxide'],
      volumeM3: 50,
    },
    chartType: 'deffeyes',
    layout: { x: 0, y: 0, w: 6, h: 7 },
  };
}
