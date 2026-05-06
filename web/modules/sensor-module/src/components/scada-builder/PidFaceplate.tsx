/**
 * PidFaceplate - ISA-101 style faceplate dialog for SCADA equipment widgets.
 *
 * Opens on double-click of a widget node. Shows equipment properties,
 * connection points, and status in a professional modal layout.
 */

import React, { useEffect, useMemo } from 'react';
import { X, Activity, Zap, CircleDot } from 'lucide-react';
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
  running: '#22c55e',
  open:    '#22c55e',
  stopped: '#9ca3af',
  closed:  '#9ca3af',
  fault:   '#ef4444',
};

const STATE_LABELS: Record<string, string> = {
  running: 'Running',
  open:    'Open',
  stopped: 'Stopped',
  closed:  'Closed',
  fault:   'Fault',
};

function getStatusColor(state: unknown): string {
  if (typeof state === 'string' && STATE_COLORS[state]) return STATE_COLORS[state];
  return '#9ca3af'; // default gray
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
  in:    'Inlet',
  out:   'Outlet',
  inout: 'Bidirectional',
};

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const PidFaceplate: React.FC<PidFaceplateProps> = ({ widget, onClose }) => {
  const { config, position: pos } = widget;

  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Resolve connection points
  const connectionPoints = useMemo<EquipmentConnectionPoint[]>(() => {
    const lookupKey =
      widget.widgetType === 'equipment'
        ? (config.equipmentSubType as string) || ''
        : widget.widgetType;
    return lookupKey in CONNECTION_POINTS
      ? CONNECTION_POINTS[lookupKey as ConnectionPointKey]
      : [];
  }, [widget.widgetType, config.equipmentSubType]);

  // Derive labels
  const equipmentLabel =
    (config.label as string) ||
    (config.equipmentSubType as string) ||
    widget.widgetType;

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
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        // Close when clicking overlay (not dialog content)
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-xl shadow-2xl w-[480px] max-h-[80vh] overflow-hidden flex flex-col">
        {/* ── Header ──────────────────────────────────────────────── */}
        <div className="bg-gray-800 text-white px-4 py-3 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            {/* Status indicator */}
            <span
              className="inline-block w-3 h-3 rounded-full shrink-0"
              style={{ backgroundColor: getStatusColor(state) }}
              title={getStatusLabel(state)}
            />
            {/* Equipment name */}
            <span className="font-semibold text-sm truncate">{equipmentLabel}</span>
            {/* Type badge */}
            <span className="text-[10px] uppercase tracking-wider bg-gray-600 px-2 py-0.5 rounded font-medium shrink-0">
              {widget.widgetType}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-700 rounded transition-colors"
            title="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* ── Main Content ────────────────────────────────────────── */}
        <div className="p-4 space-y-4 overflow-y-auto flex-1">
          {/* Two-column layout: SVG preview + Properties */}
          <div className="flex gap-4">
            {/* Left column: Equipment SVG preview */}
            <div className="w-[140px] h-[140px] shrink-0 border border-gray-200 rounded-lg bg-gray-50 flex items-center justify-center overflow-hidden">
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
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Activity size={12} />
                Properties
              </h3>
              <table className="w-full text-sm">
                <tbody>
                  {propertyRows.map((row, idx) => (
                    <tr
                      key={row.label}
                      className={idx % 2 === 0 ? 'bg-gray-50' : 'bg-white'}
                    >
                      <td className="py-1 px-2 text-gray-500 font-medium whitespace-nowrap">
                        {row.label}
                      </td>
                      <td className="py-1 px-2 text-gray-900">
                        <span className="flex items-center gap-1.5">
                          {row.color && (
                            <span
                              className="inline-block w-2 h-2 rounded-full shrink-0"
                              style={{ backgroundColor: row.color }}
                            />
                          )}
                          {row.value}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Connection Points Section ─────────────────────────── */}
          {connectionPoints.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <CircleDot size={12} />
                Connection Points
              </h3>
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-gray-100 text-gray-600">
                      <th className="py-1.5 px-2 text-left font-semibold">Port</th>
                      <th className="py-1.5 px-2 text-left font-semibold">Side</th>
                      <th className="py-1.5 px-2 text-left font-semibold">Direction</th>
                      <th className="py-1.5 px-2 text-center font-semibold">Color</th>
                    </tr>
                  </thead>
                  <tbody>
                    {connectionPoints.map((pt, idx) => (
                      <tr
                        key={pt.id}
                        className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}
                      >
                        <td className="py-1 px-2 font-mono text-gray-800">{pt.id}</td>
                        <td className="py-1 px-2 text-gray-600 capitalize">{pt.side}</td>
                        <td className="py-1 px-2 text-gray-600">
                          {DIRECTION_LABELS[pt.direction] || pt.direction}
                        </td>
                        <td className="py-1 px-2 text-center">
                          <span
                            className="inline-block w-3 h-3 rounded-full border border-white shadow-sm"
                            style={{
                              backgroundColor: CONNECTION_POINT_COLORS[pt.direction],
                            }}
                            title={pt.direction}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* ── Footer ──────────────────────────────────────────────── */}
        <div className="px-4 py-3 border-t border-gray-200 flex justify-end gap-2 shrink-0">
          <button
            className="px-4 py-1.5 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors flex items-center gap-1.5"
          >
            <Zap size={14} />
            Properties
          </button>
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm font-medium text-white bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default PidFaceplate;
