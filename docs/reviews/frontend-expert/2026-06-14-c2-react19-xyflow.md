# C2 (React 19 track) — Step 1: `reactflow` 11 → `@xyflow/react` 12 migration

**Date:** 2026-06-14 · **Agent:** frontend-expert · **Cycle:** 2026-06-14-c2-react19-xyflow
**Plan:** Platform Modernization Program — Track C (Frontend), wave C2.

## FE-MEDIUM-007 — Graph lib `reactflow` 11 is a major behind and blocks the React 19 atomic bump

**State:** OPEN → RESOLVED (Step 1) by this PR.

### Finding

The SCADA process-editor + scada-builder canvases (sensor-module) and the shared
`libs/node-components` graph-primitive library run on `reactflow@11`, a full major
version behind. `reactflow` 11 hard-pins `zustand ^4.4.1` and, more importantly,
its React 19 support is incomplete — it is the blocker for the C2 atomic
`react/react-dom 18 → 19` bump. The maintained successor is `@xyflow/react` 12,
which supports React 17/18/**19** (`peerDependencies.react: ">=17"`), so migrating
the graph lib **on React 18 first** is the architectural prerequisite that unblocks
the React 19 step (C2 Step 2) without coupling two major bumps in one change.

The 6-agent 2026-06-11 tech scan listed "React 18 / graph-lib a major generation
behind" as a verified modernization finding; this registers and resolves its
graph-lib half.

### Resolution (Step 1, this PR — React stays 18.3.1)

Architectural, root-cause migration (no shims):

1. **Imports (59 source files):** `from 'reactflow'` → `from '@xyflow/react'`;
   `import ReactFlow, {…}` → `import { ReactFlow, … }` (v12 made `ReactFlow` a
   named export); `'reactflow/dist/style.css'` → `'@xyflow/react/dist/style.css'`.
2. **v12 generics (root cause of ~360 type errors):** v12 `NodeProps<NodeType extends Node>`
   / `EdgeProps<EdgeType extends Edge>` take the **node/edge type**, and
   `Node<Data extends Record<string, unknown>>` constrains the data. Every
   `*NodeData`/`*EdgeData` `interface` now `extends Record<string, unknown>`
   (type-aliases/interfaces-with-index-sig satisfy the constraint; bare interfaces
   do not), and every `NodeProps<X>`/`EdgeProps<X>` is wrapped to
   `NodeProps<Node<X>>`/`EdgeProps<Edge<X>>` with `type Node`/`type Edge` imported.
3. **Registry typing:** `NodeRegistry`/`NodeTypeConfig.component` move from the
   generic-less `ComponentType<NodeProps>` to xyflow's own permissive `NodeTypes`
   value type, so specifically-typed node components register without contravariance
   errors.
4. **Main canvas (ScreenCanvas) v12 API deltas:** `applyNodeChanges<Node<…>>`
   explicit generic; `onPaneContextMenu` param widened to `MouseEvent | React.MouseEvent`;
   `isValidConnection` param widened to `Edge | Connection` (v12 `IsValidConnection<Edge>`).
5. **Federation SSoT + rail:** `federationSharedConfig.ts` SHARED_VERSIONS
   `reactflow 11.11.4` → `@xyflow/react 12.11.0` (exact); `getSharedConfigWithReactFlow`
   shares `@xyflow/react`; the `federation-shared-singleton` invariant's
   SINGLE_VERSION set swaps `reactflow` → `@xyflow/react`.
6. **UMD/iframe canvas:** node-components UMD `external`/`globals`
   `reactflow → @xyflow/react` (the UMD global stays `ReactFlow` — verified in
   `dist/umd/index.js`), the served `public/libs/aquaculture-nodes.umd.js`
   artifact rebuilt from migrated source, and the canvas HTML CDN `<script>`/`<link>`
   bumped to `@xyflow/react@12.11.0`.
7. **Test mock:** `vi.mock('reactflow')` → `vi.mock('@xyflow/react')`.

**zustand stays 4.5.7** — `@xyflow/react` 12.11.0 still pins `zustand ^4.4.0`
(see ORPHAN-MEDIUM-104), so the migration does not unblock zustand 5.

### Verification

- `tsc --noEmit` clean: node-components 0 (was 310), sensor-module 0 (was 54).
- `federation-shared-singleton` invariant green with `@xyflow/react` single-version
  (lockfile resolves `@xyflow/react 12.11.0` only; `reactflow` fully removed).
- `invariants:fast` 75 suites / 1140 tests green.
- sensor-module `ScadaWidgetNode` unit test 10/10 (mock migration verified).

### NOT done here (tracked, Step 2)

React 19 atomic bump (`react/react-dom 19` + `@types/react 19` +
`@testing-library/react 16` + `react-leaflet 5` + `recharts ≥2.15` +
`@monaco-editor/react 4.7`) and the AquaMobil standalone PR remain C2 Step 2.
