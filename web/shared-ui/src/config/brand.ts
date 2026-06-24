/**
 * Brand SSoT
 *
 * WHAT: the single source of truth for product brand identity used across the
 * federated app (auth surface logo alt-text, tagline, footer, support link,
 * storage-key prefix). Consumed via the @aquaculture/shared-ui barrel.
 *
 * WHY a static module (not VITE_APP_NAME): the env var was declared but never
 * defined and resolved to `undefined` at runtime. A typed constant is robust,
 * tree-shakeable, and the same value across host + every remote. The product
 * brand is "Suderra" (matches the `suderra.theme` storage key and the
 * app.suderra.com / aquamobil.suderra.com origin allowlist).
 */
export const BRAND = {
  /** Product/brand display name. */
  name: 'Suderra',
  /** Hand-written tagline shown under the auth logo (Caveat script). */
  tagline: 'Unlocks the power of farm management intelligence',
  /** In-app support route. */
  supportUrl: '/support',
  /** Prefix for brand-scoped browser storage keys (e.g. `suderra.theme`). */
  storagePrefix: 'suderra',
} as const;

export type Brand = typeof BRAND;
