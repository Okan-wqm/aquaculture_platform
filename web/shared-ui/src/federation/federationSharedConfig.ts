/**
 * Module Federation Shared Dependencies Configuration
 *
 * SECURITY: Single source of truth for ALL shared dependency versions and flags
 * used by both the shell (host) and every remote module.
 *
 * FE-HIGH-004: Without `strictVersion: true`, the federation runtime silently
 * falls back to loading a remote's bundled copy when version ranges don't
 * exactly match — producing TWO React instances at runtime. Two React instances
 * break hooks, context, QueryClient sharing, and auth state propagation.
 *
 * By importing this config in every vite.config.ts, we guarantee:
 *   1. `strictVersion: true` is ALWAYS set (structural enforcement)
 *   2. Version pins are identical across shell and all remotes
 *   3. Adding a new shared dep requires updating ONE file
 *
 * @see FE-HIGH-004
 */

// ============================================================================
// Types
// ============================================================================

export interface SharedDepConfig {
  /** Only one instance allowed at runtime */
  singleton: true;
  /** Fail loudly instead of silently loading duplicate */
  strictVersion: true;
  /** Exact version pin — must match package.json */
  requiredVersion: string;
  /** Explicit version for deps whose package.json lacks exports["./package.json"] */
  version?: string;
}

// ============================================================================
// Version Pins (update here when upgrading)
// ============================================================================

/** Canonical version pins for all shared dependencies */
export const SHARED_VERSIONS = {
  react: '19.2.7',
  'react-dom': '19.2.7',
  'react-router': '7.18.2',
  'react-router-dom': '7.18.2',
  '@tanstack/react-query': '5.90.10',
  '@aquaculture/shared-ui': '1.0.0',
  // zustand stays 4.5.7 until the graph lib @xyflow/react widens its hard
  // `zustand ^4.4.0` dependency to allow v5. As of @xyflow/react 12.11.0 (the
  // version C2 migrated to from reactflow 11) it still pins ^4.4.0, so bumping
  // zustand to 5 would resolve TWO versions in the lockfile (4.x for the graph
  // lib + 5.x here) and break the single-version singleton invariant. The code
  // already uses the v5-style `useShallow` API, which exists since 4.4.0 — so
  // there is no functional gap. See orphan-findings.md#ORPHAN-MEDIUM-104:
  // zustand 5 is gated on @xyflow/react widening its zustand range, which the
  // reactflow->xyflow migration did NOT change (12.11.0 still pins ^4.4.0).
  zustand: '4.5.7',
  '@xyflow/react': '12.11.0',
  // C0 federation rails (FE-HIGH-005): these two were previously inline
  // literals in dashboard/tenant-admin vite configs — the exact override
  // class that produced the duplicate-key + strictVersion-less entries.
  // Pins match the root-lockfile RESOLVED versions, so adopting them is a
  // config-hygiene change with zero runtime delta.
  'lucide-react': '0.469.0',
  recharts: '2.15.4',
} as const;

// ============================================================================
// Shared Configs
// ============================================================================

/**
 * Core shared dependencies required by ALL modules (shell + every remote).
 *
 * IMPORTANT: Every entry has `strictVersion: true`. This makes version
 * mismatches a BUILD-TIME error instead of a silent runtime duplicate.
 */
export function getCoreSharedConfig(): Record<string, SharedDepConfig> {
  return {
    react: {
      singleton: true,
      strictVersion: true,
      requiredVersion: SHARED_VERSIONS.react,
    },
    'react-dom': {
      singleton: true,
      strictVersion: true,
      requiredVersion: SHARED_VERSIONS['react-dom'],
    },
    'react-router': {
      singleton: true,
      strictVersion: true,
      requiredVersion: SHARED_VERSIONS['react-router'],
    },
    'react-router-dom': {
      singleton: true,
      strictVersion: true,
      requiredVersion: SHARED_VERSIONS['react-router-dom'],
    },
    '@tanstack/react-query': {
      singleton: true,
      strictVersion: true,
      requiredVersion: SHARED_VERSIONS['@tanstack/react-query'],
    },
    '@aquaculture/shared-ui': {
      singleton: true,
      strictVersion: true,
      requiredVersion: SHARED_VERSIONS['@aquaculture/shared-ui'],
    },
    zustand: {
      singleton: true,
      strictVersion: true,
      requiredVersion: SHARED_VERSIONS.zustand,
    },
  };
}

/**
 * Extended shared config that includes the graph lib @xyflow/react
 * (sensor-module SCADA builder + process editor).
 *
 * C2 (2026-06-14): migrated reactflow 11 -> @xyflow/react 12. Explicit `version`
 * is still REQUIRED because @xyflow/react's package.json exports map omits
 * "./package.json", which the Module Federation plugin uses to auto-detect the
 * version — providing `version` bypasses that resolution. (Function name kept
 * as getSharedConfigWithReactFlow to avoid churn across the federation callers;
 * it returns the graph-lib singleton, now @xyflow/react.)
 */
export function getSharedConfigWithReactFlow(): Record<string, SharedDepConfig> {
  return {
    ...getCoreSharedConfig(),
    '@xyflow/react': {
      singleton: true,
      strictVersion: true,
      requiredVersion: SHARED_VERSIONS['@xyflow/react'],
      version: SHARED_VERSIONS['@xyflow/react'],
    },
  };
}

/**
 * Extended shared config that includes recharts (dashboard charts).
 *
 * WHY here and not inline in dashboard's vite.config: the federation
 * invariant (tests/invariants/federation-shared-singleton.spec.ts) bans
 * shared-entry literals outside this file — inline entries are how the
 * strictVersion-less override class (FE-HIGH-004/FE-HIGH-005) re-enters.
 */
export function getSharedConfigWithRecharts(): Record<string, SharedDepConfig> {
  return {
    ...getCoreSharedConfig(),
    recharts: {
      singleton: true,
      strictVersion: true,
      requiredVersion: SHARED_VERSIONS.recharts,
    },
  };
}

/**
 * Extended shared config that includes BOTH the graph lib @xyflow/react AND
 * recharts — for sensor-module, which uses @xyflow/react (SCADA/process editor)
 * and now also recharts (water-chemistry cards render the promoted shared-ui
 * charts, whose recharts import is externalized from shared-ui's dist and must
 * therefore be satisfiable from the federation shared scope). Same SSoT rationale
 * as the helpers above.
 */
export function getSharedConfigWithReactFlowAndRecharts(): Record<string, SharedDepConfig> {
  return {
    ...getSharedConfigWithReactFlow(),
    recharts: {
      singleton: true,
      strictVersion: true,
      requiredVersion: SHARED_VERSIONS.recharts,
    },
  };
}

/**
 * Extended shared config that includes lucide-react (tenant-admin icons).
 * Same SSoT rationale as getSharedConfigWithRecharts above.
 */
export function getSharedConfigWithLucide(): Record<string, SharedDepConfig> {
  return {
    ...getCoreSharedConfig(),
    'lucide-react': {
      singleton: true,
      strictVersion: true,
      requiredVersion: SHARED_VERSIONS['lucide-react'],
    },
  };
}
