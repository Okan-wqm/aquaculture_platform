/**
 * PidFaceplate - ISA-101 style faceplate dialog for SCADA equipment widgets.
 *
 * Opens on double-click of a widget node. Shows equipment properties,
 * connection points, and status in a professional modal layout.
 */

import React, { useMemo } from 'react';
import { Activity, Zap, CircleDot } from 'lucide-react';
import {
  Drawer,
  colors as themeColors,
  DataTable,
  type DataTableColumn,
} from '@aquaculture/shared-ui';
import { CONNECTION_POINTS, CONNECTION_POINT_COLORS } from './equipment-symbols/types';
import type { ConnectionPointKey, EquipmentConnectionPoint } from '../../types/scada-widget.types';
import { WidgetRenderer } from './WidgetRenderer';

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface PidFaceplateProps {
  /** The widget to show details for */
  widget: {
    id: string;
    widgetType: string;
    config: Record<string, unknown>;
    position: { col: number; row: number; w: number; h: number };
  };
  /** Close the faceplate */
  onClose: () => void;
}

/* ------------------------------------------------------------------ */
/*  Status helpers                                                     */
/* ------------------------------------------------------------------ */

const STATE_COLORS: Record<string, string> = {
  running: themeColors.success[500],
  open: themeColors.success[500],
  stopped: themeColors.neutral[400],
  closed: themeColors.neutral[400],
  fault: themeColors.error[500],
};

const STATE_LABELS: Record<string, string> = {
  running: 'Running',
  open: 'Open',
  stopped: 'Stopped',
  closed: 'Closed',
  fault: 'Fault',
};

function getStatusColor(state: unknown): string {
  if (typeof state === 'string' && STATE_COLORS[state]) return STATE_COLORS[state];
  return themeColors.neutral[400]; // default gray
}

function getStatusLabel(state: unknown): string {
  if (typeof state === 'string' && STATE_LABELS[state]) return STATE_LABELS[state];
  if (typeof state === 'string' && state) return state;
  return 'Unknown';
}

/* ------------------------------------------------------------------ */
/*  Direction label helper                                             */
/* ------------------------------------------------------------------ */

const DIRECTION_LABELS: Record<string, string> = {
  in: 'Inlet',
  out: 'Outlet',
  inout: 'Bidirectional',
};

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const PidFaceplate: React.FC<PidFaceplateProps> = ({ widget, onClose }) => {
  const { config, position: pos } = widget;

  // Resolve connection points
  const connectionPoints = useMemo<EquipmentConnectionPoint[]>(() => {
    const lookupKey =
      widget.widgetType === 'equipment'
        ? (config.equipmentSubType as string) || ''
        : widget.widgetType;
    return lookupKey in CONNECTION_POINTS ? CONNECTION_POINTS[lookupKey as ConnectionPointKey] : [];
  }, [widget.widgetType, config.equipmentSubType]);

  // Derive labels
  const equipmentLabel =
    (config.label as string) || (config.equipmentSubType as string) || widget.widgetType;

  const state = config.state as string | undefined;
  const isEquipmentLike =
    widget.widgetType === 'equipment' || widget.widgetType in CONNECTION_POINTS;

  /* ---------- Property rows -------------------------------------- */
  const propertyRows: { label: string; value: string; color?: string }[] = [
    { label: 'Widget Type', value: widget.widgetType },
  ];

  if (widget.widgetType === 'equipment' && config.equipmentSubType) {
    propertyRows.push({
      label: 'Sub Type',
      value: config.equipmentSubType as string,
    });
  }

  propertyRows.push(
    { label: 'Position', value: `Col ${pos.col}, Row ${pos.row}` },
    { label: 'Size', value: `${pos.w}\u00d7${pos.h} cells` },
    {
      label: 'Tag Name',
      value: (config.tagName as string) || (config.tag as string) || '\u2014',
    },
    {
      label: 'Label',
      value: (config.label as string) || '\u2014',
    },
    {
      label: 'Status',
      value: state ? getStatusLabel(state) : '\u2014',
      color: state ? getStatusColor(state) : undefined,
    },
  );

  /* ---------- Render ---------------------------------------------- */
  type FaceplateConnectionPoint = (typeof connectionPoints)[number];
  const faceplateConnectionPointColumns: DataTableColumn<FaceplateConnectionPoint>[] = [
    {
      key: 'port',
      header: 'Port',
      render: (_value, pt) => pt.id,
    },
    {
      key: 'side',
      header: 'Side',
      render: (_value, pt) => pt.side,
    },
    {
      key: 'direction',
      header: 'Direction',
      render: (_value, pt) => DIRECTION_LABELS[pt.direction] || pt.direction,
    },
    {
      key: 'color',
      header: 'Color',
      align: 'center',
      render: (_value, pt) => (
        <span
          className="inline-block w-3 h-3 rounded-full border border-white shadow-sm"
          style={{
            backgroundColor: CONNECTION_POINT_COLORS[pt.direction],
          }}
          title={pt.direction}
        />
      ),
    },
  ];

  return (
    <Drawer
      isOpen
      onClose={onClose}
      side="right"
      size="lg"
      closeLabel="Close"
      title={
        <span className="flex items-center gap-3 min-w-0">
          {/* Status indicator */}
          <span
            className="inline-block w-3 h-3 rounded-full shrink-0"
            style={{ backgroundColor: getStatusColor(state) }}
            title={getStatusLabel(state)}
          />
          {/* Equipment name */}
          <span className="truncate">{equipmentLabel}</span>
          {/* Type badge */}
          <span className="text-[10px] uppercase tracking-wider bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 px-2 py-0.5 rounded font-medium shrink-0">
            {widget.widgetType}
          </span>
        </span>
      }
      footer={
        <>
          <button
            type="button"
            className="px-4 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors flex items-center gap-1.5"
          >
            <Zap size={14} />
            Properties
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 text-sm font-medium text-white bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
          >
            Close
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {/* Two-column layout: SVG preview + Properties */}
        <div className="flex gap-4">
          {/* Left column: Equipment SVG preview */}
          <div className="w-[140px] h-[140px] shrink-0 border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 flex items-center justify-center overflow-hidden">
            <WidgetRenderer
              widgetType={widget.widgetType}
              config={config}
              width={120}
              height={120}
              isEditing={false}
            />
          </div>

          {/* Right column: Properties table */}
          <div className="flex-1 min-w-0">
            <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <Activity size={12} />
              Properties
            </h3>
            <dl className="w-full text-sm">
              {propertyRows.map((row, idx) => (
                <div
                  key={row.label}
                  className={`flex items-center gap-3 py-1 px-2 ${idx % 2 === 0 ? 'bg-gray-50 dark:bg-gray-800' : 'bg-white dark:bg-gray-900'}`}
                >
                  <dt className="text-gray-500 dark:text-gray-400 font-medium whitespace-nowrap">{row.label}</dt>
                  <dd className="flex items-center gap-1.5 text-gray-900 dark:text-gray-100">
                    {row.color && (
                      <span
                        className="inline-block w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: row.color }}
                      />
                    )}
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>

        {/* ── Connection Points Section ─────────────────────────── */}
        {connectionPoints.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <CircleDot size={12} />
              Connection Points
            </h3>
            <DataTable<FaceplateConnectionPoint>
              data={connectionPoints}
              columns={faceplateConnectionPointColumns}
              keyExtractor={(pt) => pt.id}
              emptyMessage="No connection points"
              searchable={false}
              sortable={false}
              stickyHeader={false}
              compact
            />
          </div>
        )}
      </div>
    </Drawer>
  );
};

export default PidFaceplate;
