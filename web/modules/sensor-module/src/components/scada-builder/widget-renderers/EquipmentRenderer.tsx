/**
 * EquipmentRenderer - Renders P&ID equipment symbols (pumps, valves, tanks,
 * heat exchangers) with live state derived from the bound tag value.
 *
 * State mapping:
 *   Valve types  → truthy = 'open',    falsy = 'closed'
 *   Other types  → truthy = 'running', falsy = 'stopped'
 *   config.demoState overrides derived state (used during editing).
 */

import React, { Suspense, useMemo, useCallback, memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';
import type { EquipmentSubType, EquipmentState } from '../../../types/scada-widget.types';
import { symbolMap } from '../equipment-symbols';

/* ------------------------------------------------------------------ */
/*  Valve sub-type set for state derivation                            */
/* ------------------------------------------------------------------ */

const VALVE_TYPES = new Set<string>([
  'gateValve',
  'ballValve',
  'butterflyValve',
  'globeValve',
  'checkValve',
  'reliefValve',
  'controlValve',
  'needleValve',
  'solenoidValve',
]);

/* ------------------------------------------------------------------ */
/*  State derivation helper                                            */
/* ------------------------------------------------------------------ */

function deriveState(
  subType: string,
  value: unknown,
  demoState?: string,
): EquipmentState {
  if (demoState) return demoState as EquipmentState;

  if (value === undefined || value === null || value === '') {
    return VALVE_TYPES.has(subType) ? 'closed' : 'stopped';
  }

  const isActive =
    value === true ||
    value === 1 ||
    value === 'true' ||
    value === 'on' ||
    Number(value) > 0;

  if (VALVE_TYPES.has(subType)) {
    return isActive ? 'open' : 'closed';
  }
  return isActive ? 'running' : 'stopped';
}

/* ------------------------------------------------------------------ */
/*  EquipmentRenderer                                                  */
/* ------------------------------------------------------------------ */

const EquipmentRenderer: React.FC<WidgetRendererProps> = ({
  config,
  value,
  width,
  height,
  isEditing,
  onCommand,
}) => {
  const subType = config.equipmentSubType as EquipmentSubType | undefined;

  const state = useMemo(
    () => deriveState(subType || '', value, config.demoState as string | undefined),
    [subType, value, config.demoState],
  );

  const handleClick = useCallback(() => {
    if (!isEditing && onCommand) {
      onCommand('toggle');
    }
  }, [isEditing, onCommand]);

  /* Unknown / missing sub-type fallback */
  if (!subType || !symbolMap[subType]) {
    return (
      <div
        style={{
          width,
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#fef2f2',
          color: '#991b1b',
          fontSize: 11,
          textAlign: 'center',
          padding: 8,
        }}
      >
        Unknown equipment: {subType || 'none'}
      </div>
    );
  }

  const SymbolComponent = symbolMap[subType];

  return (
    <div
      style={{
        width,
        height,
        cursor: isEditing ? 'default' : 'pointer',
        position: 'relative',
      }}
      onClick={handleClick}
    >
      <Suspense fallback={<div style={{ width, height, background: '#f8fafc' }} />}>
        <SymbolComponent
          state={state}
          width={width}
          height={height}
          rotation={(config.rotation as number) || 0}
          showConnectionPoints={isEditing}
          label={config.label as string}
        />
      </Suspense>
    </div>
  );
};

EquipmentRenderer.displayName = 'EquipmentRenderer';
export default memo(EquipmentRenderer);
