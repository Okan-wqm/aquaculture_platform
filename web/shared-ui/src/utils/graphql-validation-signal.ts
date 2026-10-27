/**
 * The GraphQL validation-failure signal (FE-MEDIUM-380, PKG-42).
 *
 * WHY: a document the router refuses with GRAPHQL_VALIDATION_FAILED is how a tab whose bundle
 * predates a BREAKING schema release fails (ADR-051 C1, C6). The shell's build-skew check
 * (web/shell/src/shell/useBuildSkewReload.ts) must hear of it from whichever module sent the
 * query, while the clients that see the response (api-client.ts) must not know the shell.
 *
 * WHAT: a one-way signal. The GraphQL clients report every errors array they receive; a
 * response carrying the code notifies each listener once. shared-ui is a federation singleton
 * (federationSharedConfig.ts), so this module-level set is the one every remote reports into.
 * A listener holds no data, so nothing here outlives a session in a way logout must clear.
 */

/** The code the router answers a document that does not validate against the schema with. */
export const GRAPHQL_VALIDATION_FAILED = 'GRAPHQL_VALIDATION_FAILED';

/** One element of a GraphQL `errors` array, as far as this signal reads it. */
export interface ReportedGraphqlError {
  readonly extensions?: { readonly code?: unknown };
}

type ValidationFailureListener = () => void;

const listeners = new Set<ValidationFailureListener>();

/** Listen for validation failures; returns the unsubscribe. */
export function onGraphqlValidationFailure(listener: ValidationFailureListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Called by the GraphQL clients with each response's errors. */
export function reportGraphqlErrors(errors: readonly ReportedGraphqlError[]): void {
  if (!errors.some((error) => error.extensions?.code === GRAPHQL_VALIDATION_FAILED)) return;
  for (const listener of [...listeners]) listener();
}
