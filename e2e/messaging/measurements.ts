/**
 * Measurement primitives for the messaging fix program (FAZ acceptance
 * criteria are measured from HERE — see ./README.md).
 *
 * Three concerns, one module:
 *   1. Send→visible latency (`measureSendToVisible*`) — the p95 ≤1500ms
 *      budget of the messaging phases is computed from browser
 *      `performance.now()` marks, NOT Node-side timers, so the number
 *      reflects what the user's frame pipeline actually did.
 *   2. GraphQL request accounting (`countGraphqlRequests`) — a collector
 *      over `page.on('request')` that counts every /graphql round trip and
 *      parses each POST body's operationName, so per-action amplification
 *      (how many operations one keystroke/click triggers) is measurable.
 *   3. Channel-switch bleed (`assertNoBleed`) — after switching channels,
 *      ZERO pixels of the previous channel's content may remain (text
 *      absence + a screenshot artifact saved under e2e/messaging/results/).
 *
 * Plus the error-code contract assert `expectGraphqlErrorCode` used by the
 * negative-path specs (NOT_FOUND / UNAUTHENTICATED / FORBIDDEN / … — the
 * code set mirrors gateway-api's global-exception.filter SSoT).
 *
 * This module MUST stay importable without a live environment: it only
 * defines helpers, it never logs in and never issues requests on its own.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';

import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Evidence directory for measurement artifacts (screenshots, latency JSON).
 * Git-ignored — see README.md "Kanıt arşivi" for what lands here per run.
 */
export const MESSAGING_RESULTS_DIR = resolve(__dirname, 'results');

/** Persist a measurement artifact under e2e/messaging/results/. */
export function saveMeasurementEvidence(fileName: string, content: string | Uint8Array): string {
  mkdirSync(MESSAGING_RESULTS_DIR, { recursive: true });
  const target = resolve(MESSAGING_RESULTS_DIR, fileName);
  writeFileSync(target, content);
  return target;
}

// ============================================================================
// 1. Send → visible latency
// ============================================================================

/** Statistics for a latency sample series (all values in ms). */
export interface LatencySummary {
  count: number;
  /** Nearest-rank median of the samples. */
  median: number;
  /** Nearest-rank 95th percentile of the samples. */
  p95: number;
  min: number;
  max: number;
  /** Raw samples in measurement order (for archival/inspection). */
  samples: number[];
}

/**
 * Performs one send→visible measurement.
 *
 * @param page      - the page under measurement.
 * @param sendFn    - performs the send interaction (fill + submit button…)
 *                    for the given repetition index and resolves with the
 *                    locator of the message element that must become visible.
 *                    Each repetition MUST target a unique message (embed the
 *                    index in the text) so visibility of a PREVIOUS message
 *                    cannot satisfy the wait.
 * @param repetition - 0-based repetition index forwarded to `sendFn`.
 * @returns elapsed ms between the instant before `sendFn` runs and the
 *          instant the message element is visible, both read from the
 *          browser's performance.now() clock (performance.mark entries are
 *          also left in the page timeline for DevTools correlation).
 */
export async function measureSendToVisible(
  page: Page,
  sendFn: (repetition: number) => Promise<Locator>,
  repetition = 0,
): Promise<number> {
  const startMark = `messaging:send:start:${repetition}`;
  const endMark = `messaging:send:visible:${repetition}`;
  const start = await page.evaluate((mark) => {
    performance.mark(mark);
    return performance.now();
  }, startMark);

  const messageLocator = await sendFn(repetition);
  await messageLocator.waitFor({ state: 'visible' });

  const end = await page.evaluate((mark) => {
    performance.mark(mark);
    return performance.now();
  }, endMark);

  return end - start;
}

/**
 * Series wrapper: runs `measureSendToVisible` `repetitions` times (default
 * 20) and reduces the samples to median + p95. One failing repetition fails
 * the whole series — a flaky send is a finding, not noise to average away.
 */
export async function measureSendToVisibleSeries(
  page: Page,
  sendFn: (repetition: number) => Promise<Locator>,
  options: { repetitions?: number } = {},
): Promise<LatencySummary> {
  const repetitions = options.repetitions ?? 20;
  const samples: number[] = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    samples.push(await measureSendToVisible(page, sendFn, repetition));
  }
  return summarizeLatency(samples);
}

/** Nearest-rank percentile: sorted[ceil(p*n)-1]. */
function percentileNearestRank(sortedSamples: number[], p: number): number {
  if (sortedSamples.length === 0) {
    throw new Error('percentile: no samples');
  }
  const rank = Math.max(1, Math.ceil(p * sortedSamples.length));
  return sortedSamples[rank - 1] as number;
}

/** Reduces raw latency samples to the summary used by phase acceptance. */
export function summarizeLatency(samples: number[]): LatencySummary {
  if (samples.length === 0) {
    throw new Error('summarizeLatency: no samples provided');
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: samples.length,
    median: percentileNearestRank(sorted, 0.5),
    p95: percentileNearestRank(sorted, 0.95),
    min: sorted[0] as number,
    max: sorted[sorted.length - 1] as number,
    samples,
  };
}

/**
 * FAZ acceptance gate: p95 send→visible must stay within budget
 * (default 1500ms). Attach the summary next to the assert in the spec.
 */
export function assertP95WithinBudget(summary: LatencySummary, budgetMs = 1500): void {
  expect(
    summary.p95,
    `p95 send→visible ${summary.p95.toFixed(0)}ms exceeded budget ${budgetMs}ms ` +
      `(median ${summary.median.toFixed(0)}ms, max ${summary.max.toFixed(0)}ms, n=${summary.count})`,
  ).toBeLessThanOrEqual(budgetMs);
}

// ============================================================================
// 2. GraphQL request accounting (amplification measurement)
// ============================================================================

/** Immutable point-in-time view of a collector. */
export interface GraphqlRequestSnapshot {
  /** Total /graphql requests observed since start/reset. */
  total: number;
  /** Request count per operationName. */
  operations: Record<string, number>;
  /** Requests whose operationName could not be parsed. */
  unparsed: number;
  /** Count of requests whose operationName matches the messaging filter. */
  messaging: number;
}

/** Live handle returned by `countGraphqlRequests`. */
export interface GraphqlRequestCollector {
  /** Total /graphql POSTs observed since start/reset. */
  total(): number;
  /** Observed count for one operationName (0 when never seen). */
  countFor(operationName: string): number;
  /** Observed /graphql POSTs whose operationName is messaging-domain. */
  messaging(): number;
  /** Immutable copy of the current counters. */
  snapshot(): GraphqlRequestSnapshot;
  /** Zeroes all counters (the page listener stays attached). */
  reset(): void;
  /** Detaches the page listener. Safe to call more than once. */
  stop(): void;
}

/**
 * Pure counter state for /graphql traffic. Kept separate from the Page
 * binding so the accounting (and operationName parsing) is unit-testable
 * without a live browser.
 */
export class GraphqlRequestCounter {
  /** Operations considered messaging-domain for the `messaging` counter. */
  static readonly MESSAGING_NAME_PATTERN = /messag/i;

  private totalRequests = 0;
  private unparsedRequests = 0;
  private readonly operationCounts = new Map<string, number>();

  /** Feed one observed request; non-/graphql and non-POST traffic is ignored. */
  observe(url: string, method: string, postData: string | null): void {
    if (!url.includes('/graphql') || method !== 'POST') {
      return;
    }
    this.totalRequests += 1;
    const operationName = parseGraphqlOperationName(postData);
    if (operationName === undefined) {
      this.unparsedRequests += 1;
      return;
    }
    this.operationCounts.set(operationName, (this.operationCounts.get(operationName) ?? 0) + 1);
  }

  /** Total /graphql POSTs observed since start/reset. */
  total(): number {
    return this.totalRequests;
  }

  /** Observed count for one operationName (0 when never seen). */
  countFor(operationName: string): number {
    return this.operationCounts.get(operationName) ?? 0;
  }

  /** Observed /graphql POSTs whose operationName is messaging-domain. */
  messaging(): number {
    let messaging = 0;
    for (const [name, count] of this.operationCounts) {
      if (GraphqlRequestCounter.MESSAGING_NAME_PATTERN.test(name)) {
        messaging += count;
      }
    }
    return messaging;
  }

  /** Immutable copy of the current counters. */
  snapshot(): GraphqlRequestSnapshot {
    const operations: Record<string, number> = {};
    for (const [name, count] of this.operationCounts) {
      operations[name] = count;
    }
    return {
      total: this.totalRequests,
      operations,
      unparsed: this.unparsedRequests,
      messaging: this.messaging(),
    };
  }

  /** Zeroes all counters. */
  reset(): void {
    this.totalRequests = 0;
    this.unparsedRequests = 0;
    this.operationCounts.clear();
  }
}

/**
 * Extracts the operationName from a GraphQL POST body: the explicit
 * `operationName` member first, then the first named operation in the query
 * document. Returns undefined when neither is parseable.
 */
export function parseGraphqlOperationName(
  postData: string | null | undefined,
): string | undefined {
  if (typeof postData !== 'string' || postData.length === 0) {
    return undefined;
  }
  try {
    const body: unknown = JSON.parse(postData);
    if (body !== null && typeof body === 'object') {
      const explicit = (body as { operationName?: unknown }).operationName;
      if (typeof explicit === 'string' && explicit.length > 0) {
        return explicit;
      }
    }
  } catch {
    // Not JSON (e.g. a batched array or multipart body) — fall through to
    // the query-document scan.
  }
  const namedOperation = postData.match(
    /(?:query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/,
  );
  return namedOperation?.[1];
}

/**
 * Starts counting /graphql requests on the page and returns a live handle.
 *
 * Amplification-measurement pattern (the FAZ network gates):
 *   const collector = countGraphqlRequests(page);
 *   await doOneUserAction();                 // exactly one click/keystroke
 *   const amplification = collector.snapshot(); // ops triggered by it
 *   collector.stop();
 */
export function countGraphqlRequests(page: Page): GraphqlRequestCollector {
  const counter = new GraphqlRequestCounter();
  const listener = (request: { url(): string; method(): string; postData(): string | null }) => {
    counter.observe(request.url(), request.method(), request.postData());
  };
  page.on('request', listener);
  return {
    total: () => counter.total(),
    countFor: (operationName: string) => counter.countFor(operationName),
    messaging: () => counter.messaging(),
    snapshot: () => counter.snapshot(),
    reset: () => counter.reset(),
    stop: () => page.removeListener('request', listener),
  };
}

// ============================================================================
// 3. Channel-switch bleed assertion
// ============================================================================

export interface AssertNoBleedOptions {
  /**
   * A sample message body that was visible in the PREVIOUS channel. After
   * the switch it must contribute zero pixels — asserted as a 0-match count
   * on the whole page (not just the room pane: bleed into caches, toasts or
   * the sidebar would also surface this text).
   */
  previousMessageText?: string;
  /**
   * Locator of the room header that must NOT mention the previous channel
   * title anymore. Pass an explicit locator when the panel markup is known.
   */
  headerLocator?: Locator;
  /** Screenshot artifact name (saved under MESSAGING_RESULTS_DIR). */
  evidenceName?: string;
}

/**
 * Asserts that switching to a new channel left ZERO pixels of the previous
 * channel (`channelTitle`) behind:
 *   1. the previous channel's sample message text has 0 matches in the DOM;
 *   2. the previous channel title no longer headlines the room (header
 *      locator, when provided);
 *   3. a full-page screenshot is archived as visual evidence — the manual
 *      reviewer diffs this artifact against the pre-switch state.
 *
 * NOTE: this is the simplified screenshot-diff approach: pixel comparison
 * is done by the reviewer/tooling from the artifacts, while the automated
 * guarantee (0 text matches) is enforced here.
 */
export async function assertNoBleed(
  page: Page,
  channelTitle: string,
  options: AssertNoBleedOptions = {},
): Promise<void> {
  const { previousMessageText, headerLocator, evidenceName } = options;

  if (typeof previousMessageText === 'string' && previousMessageText.length > 0) {
    await expect(
      page.getByText(previousMessageText, { exact: false }),
      `bleed: previous channel message text is still rendered: "${previousMessageText}"`,
    ).toHaveCount(0);
  }

  if (headerLocator) {
    await expect(
      headerLocator,
      `bleed: room header still shows previous channel title "${channelTitle}"`,
    ).not.toContainText(channelTitle);
  }

  const evidenceFile = evidenceName ?? `no-bleed-${Date.now()}.png`;
  const buffer = await page.screenshot({ fullPage: true });
  saveMeasurementEvidence(
    evidenceFile.endsWith('.png') ? evidenceFile : `${evidenceFile}.png`,
    buffer,
  );
  expect(buffer.length, 'bleed evidence screenshot captured').toBeGreaterThan(0);
}

// ============================================================================
// 4. GraphQL error-code contract
// ============================================================================

/**
 * Error codes the gateway contractually emits in
 * `errors[0].extensions.code` (SSoT: gateway-api global-exception.filter —
 * BAD_REQUEST/UNAUTHENTICATED/FORBIDDEN/NOT_FOUND/CONFLICT/
 * UNPROCESSABLE_ENTITY/TOO_MANY_REQUESTS/INTERNAL_SERVER_ERROR).
 */
export const GRAPHQL_ERROR_CODES = [
  'BAD_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'UNPROCESSABLE_ENTITY',
  'TOO_MANY_REQUESTS',
  'INTERNAL_SERVER_ERROR',
] as const;

export type GraphQLErrorCode = (typeof GRAPHQL_ERROR_CODES)[number];

/** Minimal GraphQL error entry shape (structural, transport-agnostic). */
export interface GraphQLErrorShape {
  message?: string;
  extensions?: Record<string, unknown> | null;
}

/** Response envelope carrying optional GraphQL errors. */
export interface GraphQLErrorResponseShape {
  errors?: GraphQLErrorShape[] | null;
}

function isGraphQLErrorCode(value: unknown): value is GraphQLErrorCode {
  return typeof value === 'string' && (GRAPHQL_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Reads `errors[0].extensions.code` when the response carries at least one
 * error AND its code is part of the contractual set. Returns undefined for
 * error-free responses and for non-contractual codes (those are findings —
 * `expectGraphqlErrorCode` will surface them loudly).
 */
export function readGraphQLErrorCode(
  result: GraphQLErrorResponseShape | null | undefined,
): GraphQLErrorCode | undefined {
  const code = result?.errors?.[0]?.extensions?.['code'];
  return isGraphQLErrorCode(code) ? code : undefined;
}

/**
 * Contract assert: the response MUST carry a first error whose
 * extensions.code equals `code`. Fails with a descriptive message when the
 * response has no errors at all, or when the code does not match / is not
 * part of the contractual set.
 *
 * Usage (negative-path specs):
 *   expectGraphqlErrorCode(await client.queryRaw(...), 'NOT_FOUND');
 */
export function expectGraphqlErrorCode(
  result: GraphQLErrorResponseShape | null | undefined,
  code: GraphQLErrorCode,
): void {
  const errors = result?.errors;
  expect(
    errors,
    `expected GraphQL error code ${code} but the response has no errors ` +
      `(data: ${JSON.stringify((result as { data?: unknown } | undefined)?.data)})`,
  ).toBeTruthy();
  expect(errors?.length, 'expected at least one GraphQL error').toBeGreaterThan(0);

  const firstError = errors?.[0];
  const actualCode = firstError?.extensions?.['code'];
  if (!isGraphQLErrorCode(actualCode)) {
    throw new Error(
      `non-contractual GraphQL error code ${JSON.stringify(actualCode)} ` +
        `(expected ${code}); message: ${JSON.stringify(firstError?.message)}`,
    );
  }
  expect(actualCode, `GraphQL error code contract (message: ${firstError?.message})`).toBe(code);
}
