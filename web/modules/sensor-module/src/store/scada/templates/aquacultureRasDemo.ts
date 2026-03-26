/**
 * Built-in aquaculture RAS (Recirculating Aquaculture System) demo template.
 * Showcases the full SCADA builder capability with animated process flow,
 * real-time tag binding, alarm rules, and multi-screen navigation.
 *
 * This template is loaded when users click "Load Demo Template" in the
 * SCADA package builder. All tag names use a consistent naming convention
 * matching the aquaculture sensor-service tag schema.
 *
 * RAS Process Flow:
 *   Fish Tank -> Pump P1 -> Drum Filter -> MBBR Biofilter
 *       ^                                        |
 *       |                                        v
 *   Clean Water <- Pump P2 <- UV Sterilizer <- CO2 Degasser
 */

import type { ScadaPackageJSON } from '../types';

/* ------------------------------------------------------------------ */
/*  Screen IDs                                                         */
/* ------------------------------------------------------------------ */

const SCREEN_OVERVIEW = 'scr-ras-overview';
const SCREEN_FEEDING = 'scr-feeding-control';
const SCREEN_ALARMS = 'scr-alarms';

/* ------------------------------------------------------------------ */
/*  Widget IDs                                                         */
/* ------------------------------------------------------------------ */

// Screen 1 — RAS Overview
const W_HEADER = 'w-header-title';
const W_FISH_TANK = 'w-fish-tank';
const W_DRUM_FILTER = 'w-drum-filter';
const W_BIOFILTER = 'w-biofilter';
const W_UV_STERILIZER = 'w-uv-sterilizer';
const W_DEGASSER = 'w-degasser';
const W_CLEAN_WATER = 'w-clean-water';
const W_PUMP1 = 'w-pump1';
const W_PUMP2 = 'w-pump2';
const W_VALVE1 = 'w-valve1';
const W_DISP_DO = 'w-disp-do';
const W_DISP_PH = 'w-disp-ph';
const W_DISP_TEMP = 'w-disp-temp';
const W_DISP_PRESSURE = 'w-disp-pressure';
const W_TREND = 'w-trend-chart';
const W_ALARM_BANNER = 'w-alarm-banner';
const W_STATUS_P1 = 'w-status-p1';
const W_STATUS_P2 = 'w-status-p2';
const W_STATUS_UV = 'w-status-uv';
// Pipe segments
const W_PIPE_FT_P1 = 'w-pipe-ft-p1';
const W_PIPE_P1_DF = 'w-pipe-p1-df';
const W_PIPE_DF_BF = 'w-pipe-df-bf';
const W_PIPE_BF_DG = 'w-pipe-bf-dg';
const W_PIPE_DG_UV = 'w-pipe-dg-uv';
const W_PIPE_UV_P2 = 'w-pipe-uv-p2';
const W_PIPE_P2_CW = 'w-pipe-p2-cw';
const W_PIPE_CW_FT = 'w-pipe-cw-ft';

// Screen 2 — Feeding Control
const W_FEEDER = 'w-feeder';
const W_FEED_RATE = 'w-feed-rate-input';
const W_FEED_TREND = 'w-feed-trend';
const W_FEED_SCHEDULE = 'w-feed-schedule';
const W_FEED_HEADER = 'w-feed-header';

// Screen 3 — Alarms
const W_ALARM_LIST = 'w-alarm-list';
const W_ALARM_HEADER = 'w-alarm-header';

/* ------------------------------------------------------------------ */
/*  Edge IDs                                                           */
/* ------------------------------------------------------------------ */

const E_FT_DF = 'e-ft-to-df';
const E_DF_BF = 'e-df-to-bf';
const E_BF_DG = 'e-bf-to-dg';
const E_DG_UV = 'e-dg-to-uv';
const E_UV_CW = 'e-uv-to-cw';
const E_CW_FT = 'e-cw-to-ft';

/* ------------------------------------------------------------------ */
/*  Template Data                                                      */
/* ------------------------------------------------------------------ */

export const AQUACULTURE_RAS_DEMO: ScadaPackageJSON = {
  meta: {
    version: 1,
    packageName: 'Suderra Aquaculture - RAS Demo',
    processId: null,
    edgeDeviceId: null,
  },

  screens: [
    /* ============================================================== */
    /*  Screen 1: RAS Overview (Process)                               */
    /* ============================================================== */
    {
      id: SCREEN_OVERVIEW,
      name: 'RAS Overview',
      screenType: 'process',
      isDefault: true,
      icon: 'Workflow',
      layout: { type: 'grid', cols: 12, rows: 10 },
      widgets: [
        // ---- Alarm Banner (top) ----
        {
          id: W_ALARM_BANNER,
          widgetType: 'alarmBanner',
          name: 'Alarm Banner',
          position: { col: 0, row: 0, w: 12, h: 1 },
          config: { scrollInterval: 5 },
          zIndex: 100,
        },

        // ---- Header Title ----
        {
          id: W_HEADER,
          widgetType: 'staticText',
          name: 'Header Title',
          position: { col: 0, row: 1, w: 12, h: 1 },
          config: {
            text: 'Suderra Aquaculture \u2014 RAS Process Control',
            fontSize: 20,
            fontWeight: 'bold',
            textAlign: 'center',
            verticalAlign: 'middle',
            color: '#0e7490',
            backgroundColor: '#ecfeff',
            borderWidth: 0,
            padding: 8,
          },
          zIndex: 90,
        },

        // ---- Fish Tank (verticalTank) ----
        {
          id: W_FISH_TANK,
          widgetType: 'equipment',
          name: 'Fish Tank',
          position: { col: 0, row: 2, w: 2, h: 3 },
          config: {
            equipmentSubType: 'verticalTank',
            tagName: 'DO_tank1',
            label: 'Fish Tank',
            state: 'running',
          },
          animations: [
            {
              id: 'anim-ft-fill',
              tagName: 'level_tank1',
              type: 'fillLevel',
              range: { min: 0, max: 100 },
              options: {
                fillMin: 0,
                fillMax: 100,
                fillColor: '#38bdf8',
                fillWarningThreshold: 20,
                fillCriticalThreshold: 10,
                fillWarningColor: '#facc15',
                fillCriticalColor: '#ef4444',
              },
            },
            {
              id: 'anim-ft-color',
              tagName: 'DO_tank1',
              type: 'colorRange',
              range: { min: 0, max: 14 },
              options: {
                ranges: [
                  { min: 0, max: 5, fill: '#fca5a5', stroke: '#dc2626', label: 'Low DO' },
                  { min: 5, max: 7, fill: '#fde68a', stroke: '#f59e0b', label: 'Marginal DO' },
                  { min: 7, max: 14, fill: '#86efac', stroke: '#22c55e', label: 'Optimal DO' },
                ],
              },
            },
          ],
          zIndex: 50,
        },

        // ---- Valve 1 (Fish Tank outlet) ----
        {
          id: W_VALVE1,
          widgetType: 'equipment',
          name: 'Valve V1',
          position: { col: 2, row: 3, w: 1, h: 1 },
          config: {
            equipmentSubType: 'gateValve',
            tagName: 'valve1_open',
            label: 'V1',
            state: 'open',
          },
          animations: [
            {
              id: 'anim-v1-rot',
              tagName: 'valve1_open',
              type: 'valueMappedRotation',
              range: { min: 0, max: 100 },
              options: { minAngle: 0, maxAngle: 90 },
            },
          ],
          zIndex: 55,
        },

        // ---- Pump 1 (Fish Tank -> Filter) ----
        {
          id: W_PUMP1,
          widgetType: 'equipment',
          name: 'Pump P1',
          position: { col: 3, row: 2, w: 1, h: 1 },
          config: {
            equipmentSubType: 'centrifugalPump',
            tagName: 'pump1_running',
            label: 'P1',
            state: 'running',
          },
          animations: [
            {
              id: 'anim-p1-rot',
              tagName: 'pump1_running',
              type: 'rotate',
              range: { min: 1, max: 1 },
              options: { rotationSpeed: 2000, direction: 'cw' },
            },
          ],
          zIndex: 55,
        },

        // ---- Drum Filter (radialFilter) ----
        {
          id: W_DRUM_FILTER,
          widgetType: 'radialFilter',
          name: 'Drum Filter',
          position: { col: 4, row: 2, w: 2, h: 3 },
          config: {
            tagName: 'pressure_filter1',
            label: 'Drum Filter',
            demoStatus: 'running',
          },
          animations: [
            {
              id: 'anim-df-color',
              tagName: 'pressure_filter1',
              type: 'colorRange',
              range: { min: 0, max: 5 },
              options: {
                ranges: [
                  { min: 0, max: 2.0, fill: '#86efac', stroke: '#22c55e', label: 'Normal' },
                  { min: 2.0, max: 2.5, fill: '#fde68a', stroke: '#f59e0b', label: 'High' },
                  { min: 2.5, max: 5.0, fill: '#fca5a5', stroke: '#dc2626', label: 'Critical' },
                ],
              },
            },
          ],
          zIndex: 50,
        },

        // ---- MBBR Biofilter ----
        {
          id: W_BIOFILTER,
          widgetType: 'mbbr',
          name: 'MBBR Biofilter',
          position: { col: 8, row: 2, w: 3, h: 2 },
          config: {
            tagName: 'pH_biofilter',
            label: 'MBBR Biofilter',
            demoStatus: 'running',
          },
          animations: [
            {
              id: 'anim-bf-color',
              tagName: 'pH_biofilter',
              type: 'colorRange',
              range: { min: 0, max: 14 },
              options: {
                ranges: [
                  { min: 0, max: 6.5, fill: '#fca5a5', stroke: '#dc2626', label: 'Low pH' },
                  { min: 6.5, max: 8.5, fill: '#86efac', stroke: '#22c55e', label: 'Optimal pH' },
                  { min: 8.5, max: 14, fill: '#fca5a5', stroke: '#dc2626', label: 'High pH' },
                ],
              },
            },
          ],
          zIndex: 50,
        },

        // ---- CO2 Degasser (verticalTank) ----
        {
          id: W_DEGASSER,
          widgetType: 'equipment',
          name: 'CO2 Degasser',
          position: { col: 8, row: 5, w: 2, h: 2 },
          config: {
            equipmentSubType: 'verticalTank',
            tagName: 'co2_level',
            label: 'CO\u2082 Degasser',
            state: 'running',
          },
          animations: [
            {
              id: 'anim-dg-fill',
              tagName: 'co2_level',
              type: 'fillLevel',
              range: { min: 0, max: 100 },
              options: {
                fillMin: 0,
                fillMax: 100,
                fillColor: '#a5b4fc',
                fillWarningThreshold: 80,
                fillCriticalThreshold: 90,
                fillWarningColor: '#facc15',
                fillCriticalColor: '#ef4444',
              },
            },
          ],
          zIndex: 50,
        },

        // ---- UV Sterilizer (pressureVessel) ----
        {
          id: W_UV_STERILIZER,
          widgetType: 'equipment',
          name: 'UV Sterilizer',
          position: { col: 5, row: 5, w: 2, h: 2 },
          config: {
            equipmentSubType: 'pressureVessel',
            tagName: 'uv_intensity',
            label: 'UV Sterilizer',
            state: 'running',
          },
          animations: [
            {
              id: 'anim-uv-blink',
              tagName: 'uv_intensity',
              type: 'blink',
              range: { min: 0, max: 0 },
              options: {
                blinkInterval: 800,
                fillA: '#fef2f2',
                fillB: '#fee2e2',
                strokeA: '#ef4444',
                strokeB: '#dc2626',
              },
            },
            {
              id: 'anim-uv-color',
              tagName: 'uv_intensity',
              type: 'colorRange',
              range: { min: 0, max: 100 },
              options: {
                ranges: [
                  { min: 0, max: 1, fill: '#f3f4f6', stroke: '#9ca3af', label: 'OFF' },
                  { min: 1, max: 40, fill: '#fde68a', stroke: '#f59e0b', label: 'Low' },
                  { min: 40, max: 100, fill: '#c4b5fd', stroke: '#7c3aed', label: 'Active' },
                ],
              },
            },
          ],
          zIndex: 50,
        },

        // ---- Pump 2 (UV -> Clean Water) ----
        {
          id: W_PUMP2,
          widgetType: 'equipment',
          name: 'Pump P2',
          position: { col: 3, row: 6, w: 1, h: 1 },
          config: {
            equipmentSubType: 'centrifugalPump',
            tagName: 'pump2_running',
            label: 'P2',
            state: 'running',
          },
          animations: [
            {
              id: 'anim-p2-rot',
              tagName: 'pump2_running',
              type: 'rotate',
              range: { min: 1, max: 1 },
              options: { rotationSpeed: 2000, direction: 'cw' },
            },
          ],
          zIndex: 55,
        },

        // ---- Clean Water Tank ----
        {
          id: W_CLEAN_WATER,
          widgetType: 'cleanWaterTank',
          name: 'Clean Water Tank',
          position: { col: 0, row: 5, w: 2, h: 3 },
          config: {
            tagName: 'level_cwt',
            label: 'Clean Water',
            demoLevel: 75,
            demoStatus: 'running',
          },
          animations: [
            {
              id: 'anim-cw-fill',
              tagName: 'level_cwt',
              type: 'fillLevel',
              range: { min: 0, max: 100 },
              options: {
                fillMin: 0,
                fillMax: 100,
                fillColor: '#67e8f9',
                fillWarningThreshold: 25,
                fillCriticalThreshold: 10,
                fillWarningColor: '#facc15',
                fillCriticalColor: '#ef4444',
              },
            },
          ],
          zIndex: 50,
        },

        // ---- Pipe Flow Segments (horizontal / vertical connections) ----
        // Top row: Fish Tank -> P1
        {
          id: W_PIPE_FT_P1,
          widgetType: 'pipeFlow',
          name: 'Pipe: Fish Tank -> P1',
          position: { col: 2, row: 2, w: 1, h: 1 },
          config: {
            direction: 'horizontal',
            flowDirection: 'forward',
            pipeColor: '#6b7280',
            flowColor: '#38bdf8',
            pipeWidth: 10,
            flowSpeed: 0.6,
          },
          zIndex: 30,
        },
        // P1 -> Drum Filter
        {
          id: W_PIPE_P1_DF,
          widgetType: 'pipeFlow',
          name: 'Pipe: P1 -> Drum Filter',
          position: { col: 3, row: 3, w: 1, h: 1 },
          config: {
            direction: 'horizontal',
            flowDirection: 'forward',
            pipeColor: '#6b7280',
            flowColor: '#38bdf8',
            pipeWidth: 10,
            flowSpeed: 0.6,
          },
          zIndex: 30,
        },
        // Drum Filter -> Biofilter
        {
          id: W_PIPE_DF_BF,
          widgetType: 'pipeFlow',
          name: 'Pipe: Drum Filter -> Biofilter',
          position: { col: 6, row: 3, w: 2, h: 1 },
          config: {
            direction: 'horizontal',
            flowDirection: 'forward',
            pipeColor: '#6b7280',
            flowColor: '#38bdf8',
            pipeWidth: 10,
            flowSpeed: 0.6,
          },
          zIndex: 30,
        },
        // Biofilter -> Degasser (vertical down)
        {
          id: W_PIPE_BF_DG,
          widgetType: 'pipeFlow',
          name: 'Pipe: Biofilter -> Degasser',
          position: { col: 9, row: 4, w: 1, h: 1 },
          config: {
            direction: 'vertical',
            flowDirection: 'forward',
            pipeColor: '#6b7280',
            flowColor: '#38bdf8',
            pipeWidth: 10,
            flowSpeed: 0.6,
          },
          zIndex: 30,
        },
        // Degasser -> UV
        {
          id: W_PIPE_DG_UV,
          widgetType: 'pipeFlow',
          name: 'Pipe: Degasser -> UV',
          position: { col: 7, row: 6, w: 1, h: 1 },
          config: {
            direction: 'horizontal',
            flowDirection: 'reverse',
            pipeColor: '#6b7280',
            flowColor: '#a5b4fc',
            pipeWidth: 10,
            flowSpeed: 0.6,
          },
          zIndex: 30,
        },
        // UV -> P2
        {
          id: W_PIPE_UV_P2,
          widgetType: 'pipeFlow',
          name: 'Pipe: UV -> P2',
          position: { col: 4, row: 6, w: 1, h: 1 },
          config: {
            direction: 'horizontal',
            flowDirection: 'reverse',
            pipeColor: '#6b7280',
            flowColor: '#67e8f9',
            pipeWidth: 10,
            flowSpeed: 0.6,
          },
          zIndex: 30,
        },
        // P2 -> Clean Water
        {
          id: W_PIPE_P2_CW,
          widgetType: 'pipeFlow',
          name: 'Pipe: P2 -> Clean Water',
          position: { col: 2, row: 6, w: 1, h: 1 },
          config: {
            direction: 'horizontal',
            flowDirection: 'reverse',
            pipeColor: '#6b7280',
            flowColor: '#67e8f9',
            pipeWidth: 10,
            flowSpeed: 0.6,
          },
          zIndex: 30,
        },
        // Clean Water -> Fish Tank (vertical up, return loop)
        {
          id: W_PIPE_CW_FT,
          widgetType: 'pipeFlow',
          name: 'Pipe: Clean Water -> Fish Tank',
          position: { col: 0, row: 5, w: 1, h: 1 },
          config: {
            direction: 'vertical',
            flowDirection: 'reverse',
            pipeColor: '#6b7280',
            flowColor: '#67e8f9',
            pipeWidth: 10,
            flowSpeed: 0.6,
          },
          zIndex: 30,
        },

        // ---- Numeric Displays ----
        // Dissolved Oxygen (near Fish Tank)
        {
          id: W_DISP_DO,
          widgetType: 'numericDisplay',
          name: 'DO Display',
          position: { col: 2, row: 4, w: 2, h: 1 },
          config: {
            tagName: 'DO_tank1',
            label: 'Dissolved O\u2082',
            unit: 'mg/L',
            decimals: 1,
          },
          zIndex: 60,
        },
        // pH (near Biofilter)
        {
          id: W_DISP_PH,
          widgetType: 'numericDisplay',
          name: 'pH Display',
          position: { col: 10, row: 4, w: 2, h: 1 },
          config: {
            tagName: 'pH_biofilter',
            label: 'pH',
            unit: '',
            decimals: 2,
          },
          zIndex: 60,
        },
        // Temperature (near Fish Tank)
        {
          id: W_DISP_TEMP,
          widgetType: 'numericDisplay',
          name: 'Temperature Display',
          position: { col: 2, row: 5, w: 2, h: 1 },
          config: {
            tagName: 'temp_tank1',
            label: 'Temperature',
            unit: '\u00B0C',
            decimals: 1,
          },
          zIndex: 60,
        },
        // Filter Pressure
        {
          id: W_DISP_PRESSURE,
          widgetType: 'numericDisplay',
          name: 'Filter Pressure',
          position: { col: 6, row: 2, w: 2, h: 1 },
          config: {
            tagName: 'pressure_filter1',
            label: 'Filter dP',
            unit: 'bar',
            decimals: 2,
          },
          zIndex: 60,
        },

        // ---- Status Indicators ----
        {
          id: W_STATUS_P1,
          widgetType: 'statusIndicator',
          name: 'P1 Status',
          position: { col: 4, row: 4, w: 1, h: 1 },
          config: {
            tagName: 'pump1_running',
            label: 'P1',
            activeColor: '#22c55e',
            inactiveColor: '#ef4444',
            onLabel: 'RUN',
            offLabel: 'STOP',
          },
          zIndex: 60,
        },
        {
          id: W_STATUS_P2,
          widgetType: 'statusIndicator',
          name: 'P2 Status',
          position: { col: 3, row: 7, w: 1, h: 1 },
          config: {
            tagName: 'pump2_running',
            label: 'P2',
            activeColor: '#22c55e',
            inactiveColor: '#ef4444',
            onLabel: 'RUN',
            offLabel: 'STOP',
          },
          zIndex: 60,
        },
        {
          id: W_STATUS_UV,
          widgetType: 'statusIndicator',
          name: 'UV Status',
          position: { col: 5, row: 7, w: 1, h: 1 },
          config: {
            tagName: 'uv_intensity',
            label: 'UV',
            activeColor: '#7c3aed',
            inactiveColor: '#9ca3af',
            onLabel: 'ON',
            offLabel: 'OFF',
          },
          zIndex: 60,
        },

        // ---- Trend Chart ----
        {
          id: W_TREND,
          widgetType: 'trendChart',
          name: 'Process Trends',
          position: { col: 0, row: 8, w: 12, h: 2 },
          config: {
            tags: ['DO_tank1', 'pH_biofilter', 'temp_tank1'],
            showGrid: true,
            showLegend: true,
            defaultRange: '1h',
            chartHeightMode: 'auto',
          },
          zIndex: 40,
        },
      ],

      // ---- Edge Connections (P&ID process-pipe, orthogonal routing) ----
      edges: [
        {
          id: E_FT_DF,
          source: W_FISH_TANK,
          target: W_DRUM_FILTER,
          sourceHandle: 'outlet',
          targetHandle: 'inlet',
          type: 'orthogonal',
          data: {
            connectionType: 'process-pipe',
            animated: true,
            label: 'Raw Water',
            routingMode: 'horizontal-first',
          },
        },
        {
          id: E_DF_BF,
          source: W_DRUM_FILTER,
          target: W_BIOFILTER,
          sourceHandle: 'outlet',
          targetHandle: 'inlet',
          type: 'orthogonal',
          data: {
            connectionType: 'process-pipe',
            animated: true,
            label: 'Filtered',
            routingMode: 'horizontal-first',
          },
        },
        {
          id: E_BF_DG,
          source: W_BIOFILTER,
          target: W_DEGASSER,
          sourceHandle: 'outlet',
          targetHandle: 'inlet',
          type: 'orthogonal',
          data: {
            connectionType: 'process-pipe',
            animated: true,
            routingMode: 'vertical-first',
          },
        },
        {
          id: E_DG_UV,
          source: W_DEGASSER,
          target: W_UV_STERILIZER,
          sourceHandle: 'outlet',
          targetHandle: 'inlet',
          type: 'orthogonal',
          data: {
            connectionType: 'process-pipe',
            animated: true,
            routingMode: 'horizontal-first',
          },
        },
        {
          id: E_UV_CW,
          source: W_UV_STERILIZER,
          target: W_CLEAN_WATER,
          sourceHandle: 'outlet',
          targetHandle: 'inlet',
          type: 'orthogonal',
          data: {
            connectionType: 'process-pipe',
            animated: true,
            label: 'Treated',
            routingMode: 'horizontal-first',
          },
        },
        {
          id: E_CW_FT,
          source: W_CLEAN_WATER,
          target: W_FISH_TANK,
          sourceHandle: 'outlet',
          targetHandle: 'inlet',
          type: 'orthogonal',
          data: {
            connectionType: 'process-pipe',
            animated: true,
            label: 'Return',
            routingMode: 'vertical-first',
          },
        },
      ],
    },

    /* ============================================================== */
    /*  Screen 2: Feeding Control                                      */
    /* ============================================================== */
    {
      id: SCREEN_FEEDING,
      name: 'Feeding Control',
      screenType: 'control',
      isDefault: false,
      icon: 'Gauge',
      layout: { type: 'grid', cols: 12, rows: 8 },
      widgets: [
        // Header
        {
          id: W_FEED_HEADER,
          widgetType: 'staticText',
          name: 'Feeding Header',
          position: { col: 0, row: 0, w: 12, h: 1 },
          config: {
            text: 'Feeding Control & Scheduling',
            fontSize: 18,
            fontWeight: 'bold',
            textAlign: 'center',
            verticalAlign: 'middle',
            color: '#0e7490',
            backgroundColor: '#ecfeff',
            borderWidth: 0,
            padding: 8,
          },
          zIndex: 90,
        },

        // Feeder widget
        {
          id: W_FEEDER,
          widgetType: 'feeder',
          name: 'Auto Feeder',
          position: { col: 0, row: 1, w: 2, h: 3 },
          config: {
            tagName: 'feed_level',
            label: 'Auto Feeder',
            demoFeedLevel: 65,
            demoStatus: 'running',
          },
          zIndex: 50,
        },

        // Feed rate numeric input
        {
          id: W_FEED_RATE,
          widgetType: 'numericInput',
          name: 'Feed Rate Input',
          position: { col: 3, row: 1, w: 2, h: 2 },
          config: {
            tagName: 'feed_rate',
            label: 'Feed Rate (g/min)',
            min: 0,
            max: 500,
            step: 5,
          },
          zIndex: 50,
        },

        // Feed schedule (scheduler widget)
        {
          id: W_FEED_SCHEDULE,
          widgetType: 'scheduler',
          name: 'Feeding Schedule',
          position: { col: 6, row: 1, w: 6, h: 3 },
          config: {
            tagName: 'feed_schedule',
            label: 'Weekly Feeding Schedule',
          },
          zIndex: 50,
        },

        // Feed history trend chart
        {
          id: W_FEED_TREND,
          widgetType: 'trendChart',
          name: 'Feed History',
          position: { col: 0, row: 4, w: 12, h: 4 },
          config: {
            tags: ['feed_rate', 'feed_total_daily', 'DO_tank1'],
            showGrid: true,
            showLegend: true,
            defaultRange: '24h',
            chartHeightMode: 'auto',
          },
          zIndex: 40,
        },
      ],
      edges: [],
    },

    /* ============================================================== */
    /*  Screen 3: Alarms                                               */
    /* ============================================================== */
    {
      id: SCREEN_ALARMS,
      name: 'Alarms',
      screenType: 'alarms',
      isDefault: false,
      icon: 'AlertTriangle',
      layout: { type: 'grid', cols: 12, rows: 8 },
      widgets: [
        // Header
        {
          id: W_ALARM_HEADER,
          widgetType: 'staticText',
          name: 'Alarms Header',
          position: { col: 0, row: 0, w: 12, h: 1 },
          config: {
            text: 'Alarm Management',
            fontSize: 18,
            fontWeight: 'bold',
            textAlign: 'center',
            verticalAlign: 'middle',
            color: '#b91c1c',
            backgroundColor: '#fef2f2',
            borderWidth: 0,
            padding: 8,
          },
          zIndex: 90,
        },

        // Alarm list
        {
          id: W_ALARM_LIST,
          widgetType: 'alarmList',
          name: 'Active Alarms',
          position: { col: 0, row: 1, w: 12, h: 7 },
          config: {
            title: 'Active & Historical Alarms',
            showActive: true,
          },
          zIndex: 50,
        },
      ],
      edges: [],
    },
  ],

  /* ================================================================ */
  /*  Alarm Rules                                                      */
  /* ================================================================ */
  alarmRules: [
    {
      id: 'alarm-do-critical',
      tag: 'DO_tank1',
      condition: '<',
      value: 4.0,
      severity: 'critical',
      message: 'Low dissolved oxygen - fish stress risk',
      deadband: 0.2,
      delay: 5,
    },
    {
      id: 'alarm-do-warning',
      tag: 'DO_tank1',
      condition: '<',
      value: 5.5,
      severity: 'warning',
      message: 'Dissolved oxygen below optimal range',
      deadband: 0.3,
      delay: 10,
    },
    {
      id: 'alarm-ph-low',
      tag: 'pH_biofilter',
      condition: '<',
      value: 6.5,
      severity: 'warning',
      message: 'pH too low - check biofilter',
      deadband: 0.1,
      delay: 15,
    },
    {
      id: 'alarm-ph-high',
      tag: 'pH_biofilter',
      condition: '>',
      value: 8.5,
      severity: 'warning',
      message: 'pH too high - check CO2 injection',
      deadband: 0.1,
      delay: 15,
    },
    {
      id: 'alarm-temp-high',
      tag: 'temp_tank1',
      condition: '>',
      value: 28,
      severity: 'warning',
      message: 'Temperature above threshold - check cooling',
      deadband: 0.5,
      delay: 30,
    },
    {
      id: 'alarm-filter-pressure',
      tag: 'pressure_filter1',
      condition: '>',
      value: 3.0,
      severity: 'critical',
      message: 'Filter pressure high - cleaning required',
      deadband: 0.1,
      delay: 5,
    },
  ],

  /* ================================================================ */
  /*  Control Permissions (ISA-101 standard)                           */
  /* ================================================================ */
  controlPermissions: {
    securityLevels: {
      none: ['pump1_running', 'pump2_running', 'uv_intensity'],
      confirm: ['valve1_open', 'feed_rate'],
      pin: [],
    },
    pinHash: null,
    emergencyStop: {
      holdDuration: 3000,
      affectedTags: ['pump1_running', 'pump2_running', 'uv_intensity', 'feed_rate'],
      resetRequiresPin: false,
    },
  },

  /* ================================================================ */
  /*  Trend Configuration                                              */
  /* ================================================================ */
  trendConfig: {
    retentionDays: 30,
    sampleIntervalSec: 60,
    tags: [
      'DO_tank1',
      'pH_biofilter',
      'temp_tank1',
      'pressure_filter1',
      'level_cwt',
      'co2_level',
      'feed_rate',
      'feed_total_daily',
    ],
  },
};
