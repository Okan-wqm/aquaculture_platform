# SCADA Builder Bug Audit Report

**Date**: 2026-03-25
**Auditor**: AI Code Review Agent (Opus 4.6)
**Scope**: All SCADA builder files in sensor-module

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 2 |
| HIGH | 4 |
| MEDIUM | 8 |
| LOW | 6 |
| **Total** | **20** |

| Category | Count |
|----------|-------|
| Security | 6 |
| Bug | 7 |
| Performance | 4 |
| Type Safety | 2 |
| Architecture | 1 |

---

## CRITICAL Issues

### #1 — SVG XSS via CustomSvgRenderer (CRITICAL/Security)
- **File**: `widget-renderers/CustomSvgRenderer.tsx:46-49`
- **Issue**: Regex-based SVG sanitization trivially bypassed. `<script src="evil.js"/>`, unquoted `onclick=alert(1)`, `<foreignObject>`, `<embed>`, `<use href="data:...">` not stripped. `dangerouslySetInnerHTML` on line 56.
- **Impact**: Stored XSS in multi-tenant SCADA platform. Session token theft, alarm display manipulation.
- **Fix**: Replace regex with DOMPurify. Config: `{ USE_PROFILES: { svg: true }, FORBID_TAGS: ['foreignObject', 'script', 'iframe', 'embed', 'object'], FORBID_ATTR: ['xlink:href'] }`

### #2 — Conditional Hook Calls in ScadaWidgetNode (CRITICAL/Bug)
- **File**: `nodes/ScadaWidgetNode.tsx:155-163`
- **Issue**: `useScadaRuntime`, `useAnimationState`, `useWidgetEvents` called inside try/catch. If runtime context unavailable, hooks skipped — violates Rules of Hooks.
- **Impact**: Hook count changes between renders → React internal state corruption, hard crashes.
- **Fix**: Use `useContext(ScadaRuntimeContext)` directly (returns null), always call all hooks with no-op values when runtime unavailable.

---

## HIGH Issues

### #3 — `runScript`/`openUrl` Events Declared but Unhandled (HIGH/Security+Bug)
- **File**: `engine/events/types.ts:9-10`, `engine/ScadaRuntime.tsx:27-33`
- **Issue**: EventAction type declares `'runScript'` and `'openUrl'` but no handlers registered. Events silently dropped at runtime.
- **Impact**: User-configured events fail silently. Future naive handlers could enable XSS/open redirect.
- **Fix**: Remove from EventAction type until properly implemented, or implement with URL validation + sandboxed script execution.

### #4 — Per-Widget `<style>` Injection (HIGH/Performance)
- **File**: `nodes/ScadaWidgetNode.tsx:437`
- **Issue**: Every widget instance renders `<style>{HANDLE_HOVER_CSS}</style>`. 100+ widgets = 100+ identical style elements.
- **Impact**: CSS engine re-evaluates all rules per widget mount. Visible jank on large canvases.
- **Fix**: Move to AnimationStyles.ts or ScreenCanvas level — inject once.

### #5 — Unvalidated Video Stream URL (HIGH/Security)
- **File**: `widget-renderers/VideoStreamRenderer.tsx:74-88`
- **Issue**: `streamUrl` used directly in `<video src>` / `<img src>`. No protocol validation. `javascript:`, `data:`, internal network URLs accepted.
- **Impact**: SSRF, content injection, cloud metadata exfiltration in edge deployments.
- **Fix**: Validate only `http:`/`https:` protocol. Reject `javascript:`, `data:`, `blob:`, `file:`.

### #6 — localStorage Theme Key Not Tenant-Scoped (HIGH/Security)
- **File**: `engine/theme/ThemeProvider.tsx:15,29,57`
- **Issue**: `'scada-theme-mode'` fixed key. Cross-tenant data leakage when same browser used by multiple tenants.
- **Impact**: Theme preference bleeds between tenants. Sets dangerous pattern for future localStorage usage.
- **Fix**: Scope key with tenant ID: `` `scada-theme-mode-${getTenantId()}` ``

---

## MEDIUM Issues

### #7 — AnimationStyles Injection Never Cleaned Up
- **File**: `engine/animation/AnimationStyles.ts:16-28`
- Module-level `injected` flag survives HMR. Styles lost if MFE unmounted/remounted.
- **Fix**: Check `document.getElementById()` instead of module-level boolean.

### #8 — Zustand useShallow Extracts 30+ Properties
- **File**: `pages/scada/ScadaPackageBuilderPage.tsx:116-147`
- Any change to any of 30+ properties re-renders entire builder page. Simulation tag updates cause jank.
- **Fix**: Split into focused selectors. Extract stable action references separately.

### #9 — TrendChart Sim Buffer One Update Behind
- **File**: `widget-renderers/TrendChartRenderer.tsx:37-52`
- Ref mutated in useEffect after render, but useMemo reads during render → stale data.
- **Fix**: Convert simBufferRef to useState or move mutation into useMemo.

### #10 — Direct setState Outside Store
- **File**: `pages/scada/ScadaPackageBuilderPage.tsx:250`
- `useScadaPackageStore.setState({ isDirty: false })` bypasses middleware.
- **Fix**: Add `markClean()` store action.

### #11 — `as any` Casts for Store Methods
- **File**: `CanvasContextMenu.tsx:170-219`, `ScadaPackageBuilderPage.tsx:348`
- Store methods called via `(store as any).bringToFront(...)` — no type safety.
- **Fix**: Add proper type declarations to store interface.

### #12 — Background Image Upload No Size Limit
- **File**: `CanvasSettings.tsx:71-83`
- No file size validation. 50MB image → 67MB base64 in store.
- **Fix**: Add `if (file.size > 5 * 1024 * 1024)` check.

### #13 — Custom SVG Upload No Size Limit or Validation
- **File**: `widget-configs/CustomSvgConfig.tsx:21-33`
- No file size check, no content validation beyond `.svg` extension.
- **Fix**: Max 500KB, sanitize at upload time, validate `<svg` root.

### #14 — useTagValues N+1 Subscription Pattern
- **File**: `engine/tags/useTagValues.ts:20-31`
- N tags updating simultaneously → N separate state updates → N re-renders.
- **Fix**: Batch updates via wildcard subscription or `unstable_batchedUpdates`.

---

## LOW Issues

### #15 — WidgetErrorBoundary No Recovery
- `WidgetRenderer.tsx:128-158` — No retry button, permanent error state after transient failure.

### #16 — VideoStream Fullscreen State Desync
- `VideoStreamRenderer.tsx:24-33` — Escape key exits fullscreen but doesn't update state.

### #17 — Record<string, any> in Widget Config Props
- `widget-configs/index.ts:36-37` — No compile-time type safety for widget configs.

### #18 — handleWidgetConfigChange Race Condition
- `ScadaPackageBuilderPage.tsx:294-307` — Rapid successive changes can lose intermediate values.

### #19 — TagValueBus No Dispose on Runtime Unmount
- `engine/tags/TagValueBus.ts` — ScadaRuntime never calls clear() on unmount.

### #20 — Scheduler Negative Width for Overnight Entries
- `widget-renderers/SchedulerRenderer.tsx:98` — `endHour < startHour` produces negative width.

---

## Phase 0 Prerequisites (Must Fix Before New Features)

1. **#1 + #13**: DOMPurify SVG sanitization pipeline + size limits
2. **#2**: Fix conditional hooks in ScadaWidgetNode
3. **#3 + #5**: Security hardening (remove unhandled events, validate URLs)
4. **#6**: Tenant-scope all localStorage keys
5. **#14**: Fix N+1 subscription pattern for scalability
6. **#15**: Add error boundary recovery
