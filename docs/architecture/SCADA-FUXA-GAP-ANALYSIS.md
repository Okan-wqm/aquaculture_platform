# SCADA Builder — FUXA Gap Analysis & Enterprise Implementation Plan

**Date**: 2026-03-25
**Status**: Active
**Reference**: https://github.com/frangoteam/FUXA

## Executive Summary

Suderra SCADA Builder vs FUXA open-source SCADA/HMI comparison. Suderra already surpasses FUXA in equipment symbols (59 vs ~20), edge/connection system (3 types vs 1), simulation mode, scene hierarchy, theme system, and aquaculture-specific features. Key gaps exist in SVG editing tools, SVG property panel depth, layer management, animation variety, and scripting.

---

## Overall Score

| Area | FUXA | Suderra | Winner |
|------|------|---------|--------|
| Widget Variety | ~20 controls + shapes | 34 widgets + 25 equipment = 59 | **Suderra** |
| Equipment Symbols | Generic proc-eng shapes | ISA-5.1 standard, per-subtype connection points | **Suderra** |
| Edge/Connection System | Pipe component (single type) | 3 edge types (orthogonal, polyline, bezier) + P&ID | **Suderra** |
| Animation Engine | 14 action types, SVG.js | 7 rule types, CSS keyframe | **FUXA** |
| SVG Editor | SVG-edit (full vector editor) | ReactFlow + basic shapes | **FUXA** |
| SVG Properties | Transform, stroke, fill, marker, gradient | Fill, stroke, opacity, cornerRadius | **FUXA** |
| Scripting | Full JS scripting (client+server) | None | **FUXA** |
| Theme/Dark Mode | Basic theme | Professional token system | **Suderra** |
| Simulation | None (runtime only) | Full simulation mode + scenarios | **Suderra** |
| Multi-view/Hierarchy | Flat view list | Hierarchical scene tree + breadcrumb | **Suderra** |
| Deployment | None (web only) | Edge device deployment | **Suderra** |
| Protocol Support | 14 protocols (Modbus, S7, OPC-UA...) | MQTT + API (via sensor-service) | **FUXA** |

---

## Critical Gaps (FUXA has, Suderra missing)

### 1. SVG Drawing Tools
| Tool | FUXA | Suderra | Priority |
|------|------|---------|----------|
| Freehand/Pencil drawing | Yes | NO | HIGH |
| Path tool (Bezier/polyline) | Yes | NO | HIGH |
| Ellipse | Yes | NO | MEDIUM |
| Polygon/Polyline | Via path tool | NO | MEDIUM |
| Image widget (PNG/JPG) | Yes | Background only | HIGH |
| SVG element selection & edit | Full DOM access | Widget-based only | HIGH |

### 2. SVG Property Panel
| Property | FUXA | Suderra | Priority |
|----------|------|---------|----------|
| Transform (rotate/scale/skew) | Angle input, x/y position | NO | CRITICAL |
| Stroke dash patterns (5 types) | solid, dotted, dashed, dash-dot, dash-dot-dot | Only dashArray (line) | HIGH |
| Line cap (butt/square/round) | Yes | NO | MEDIUM |
| Line join (miter/round/bevel) | Yes | NO | MEDIUM |
| Markers (arrows - start/mid/end) | Yes | NO | HIGH |
| Gradient fill | Color picker + alpha | NO | MEDIUM |
| Alpha/opacity per-color | Fill and stroke separate alpha | Only general opacity | MEDIUM |
| SVG Filters (blur, shadow, glow) | Shadow (disabled but exists) | NO | LOW |

### 3. SVG Layer/Hierarchy Management
| Feature | FUXA | Suderra | Priority |
|---------|------|---------|----------|
| Layers panel (element list) | SVG Selector panel | NO (context menu z-order) | HIGH |
| Layer duplicate/delete/merge | Yes | NO | MEDIUM |
| Bring Forward / Send Backward (single step) | Yes (4 levels) | Only front/back (2 levels) | MEDIUM |
| Element hover → highlight on canvas | Yes | NO | MEDIUM |

### 4. Animation Gaps
| Animation | FUXA | Suderra | Priority |
|-----------|------|---------|----------|
| Down-Up (piston) | Yes | NO | HIGH |
| Pipe image-in-path animation | SVG images move along pipe | NO | HIGH |
| Value-mapped rotation (min/max angle) | Yes (angle range) | Only continuous rotation | CRITICAL |
| Recursive color change (all children) | walkTreeNode | Container level only | MEDIUM |
| Video controls (start/pause/reset) | Yes | NO | LOW |

### 5. Scripting System
| Feature | FUXA | Suderra | Priority |
|---------|------|---------|----------|
| Client-side JS scripting | $setTag, $getTag, $setView... | NO | HIGH |
| Server-side scripting | Node.js execution | NO | MEDIUM |
| Script scheduling (interval/cron) | Yes | NO | MEDIUM |
| Expression engine (computed tags) | Scale functions | NO | HIGH |

---

## Suderra Advantages Over FUXA

| Area | Detail |
|------|--------|
| Equipment Symbols | 25 ISA-standard subtypes (6 pumps, 9 valves, 6 tanks, 5 heat exchangers) |
| Edge Types | 3 edge types (orthogonal+polyline+bezier) + P&ID connection types |
| Connection Points | Per-widget directional ports (in/out/inout, ISA-5.1 color standard) |
| Simulation Mode | Tag injection, scenario save, alarm sim, automation closed-loop |
| Scene Hierarchy | Tree view + breadcrumb + drag-to-reparent |
| Theme System | Professional token system (23 tokens, light/dark/system) |
| Template Sub-views | Variable mapping pipeline for parametric templates |
| CSV Tag Import/Export | Bulk tag management |
| Smart Guides | Alignment guide lines during drag |
| Canvas Ruler | Viewport+zoom aware rulers |
| Automation Binding | ST program variable mapping to widgets |
| Edge Device Deploy | Direct deploy to edge devices |
| Aquaculture-specific | Feeder, MBBR, HEPA, Radial Filter, Cornell Dual Drain, RAS tanks |
| Tenant Isolation | Per-tenant schema, data isolation, multi-tenant architecture |

---

## Architecture Notes

- **Tenant Isolation**: Each tenant has its own PostgreSQL schema + TimescaleDB hypertables
- **Database**: PostgreSQL (entities/relations) + TimescaleDB (time-series sensor data)
- **Frontend**: React + TypeScript + ReactFlow + Zustand
- **Module Federation**: sensor-module is a federated micro-frontend
- **Runtime**: ScadaRuntime context with TagValueBus + WidgetEventBus + AnimationEngine
