/**
 * Preview data — the one way to show a value whose backend does not exist yet
 * (FE-MEDIUM-337; Okan decision 2026-10-16).
 *
 * WHY: a console page whose backend is not built yet (a budget per cost
 * centre, a unified command log, per-module alarm counts) had two choices:
 * render nothing, or render invented numbers that read as real ones. The farm
 * no-mock gate forbade every mock import, and nothing in the type system told
 * a labelled preview from fake data presented as real.
 *
 * WHAT: `definePreviewData(source, value)` returns an opaque handle. The value
 * lives in this module's private WeakMap, keyed by the handle; the handle has
 * no field, symbol or JSON form that holds it. `MockPreview` — in this module,
 * the only reader — hands the value to a render prop and always draws the
 * notice beside it (a block band or an inline MOCK chip) that names the reason
 * and the tracked finding. A page cannot show preview data without its notice
 * (tier 1). Where preview data may live and which finding it names is tier 3:
 * tests/invariants/web-preview-data-path.spec.ts — `*.preview.ts` files export
 * only `definePreviewData` results naming an unresolved finding (OPEN,
 * IN-PROGRESS, BLOCKED or STALE; RESOLVED fails the gate) whose review file
 * exists, only files that render MockPreview import them, nothing else names
 * `definePreviewData`, and no production web file imports a module named
 * mock. That the handle stays unreadable is proven by the compiler at the
 * foot of this file.
 *
 * The WeakMap holds sample values written in source, never tenant data, and
 * a handle lives as long as the module that defined it, so there is nothing
 * for logout cleanup to clear.
 */
import { createElement, type ReactElement, type ReactNode } from 'react';

import type { MessageKey } from '../i18n';

import { PreviewChip } from './PreviewChip';
import { PreviewNotice } from './PreviewNotice';

/** A registry id with its severity part: `FARM-MEDIUM-439`, `FE-LOW-338`. */
export type PreviewFindingId = `${string}-${'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'}-${number}`;

/** Why a value is a preview and what would replace it. */
export interface PreviewSource {
  /**
   * The unresolved finding (OPEN, IN-PROGRESS, BLOCKED or STALE; RESOLVED
   * fails the gate) in docs/reviews/_registry/findings.jsonl that tracks the
   * missing backend.
   */
  readonly finding: PreviewFindingId;
  /** The sentence the notice shows: what is missing, in the reader's language. */
  readonly reasonKey: MessageKey;
  /** The backend query or entity that would feed this view once it exists. */
  readonly needs: string;
}

/**
 * The only name of the value slot. Declared, never defined: no runtime symbol
 * exists, so nothing can index a handle with it, and nothing outside this
 * module can spell the key to build a handle by hand.
 */
declare const previewValue: unique symbol;

/**
 * An opaque handle to a preview value. `T` is carried for the render prop's
 * type only — the handle has no member that yields the value; render it with
 * `<MockPreview data={…}>{(value) => …}</MockPreview>`.
 */
export interface PreviewData<T> {
  readonly [previewValue]: T;
}

/** The runtime handle: an empty, frozen object; the `declare` slot emits nothing. */
class PreviewHandle<T> implements PreviewData<T> {
  declare readonly [previewValue]: T;
}

/**
 * What a reader hands an entry: the render prop. `render` is a method, and
 * TypeScript compares method parameters both ways, so one map can hold
 * entries of every `T` with no cast. That is sound here because a handle and
 * its entry are paired once, in `definePreviewData`, and the only reader
 * passes the render prop typed by the same handle's `T`.
 */
interface PreviewSink {
  render(value: never): ReactNode;
}

interface PreviewEntry {
  readonly source: PreviewSource;
  /** Hands the value to the sink and returns what it rendered; the value itself never leaves. */
  reveal(sink: PreviewSink): ReactNode;
}

const PREVIEW_ENTRIES = new WeakMap<PreviewData<unknown>, PreviewEntry>();

/**
 * Declare preview data for a view whose backend does not exist yet. Call it
 * only in a `*.preview.ts` file, one exported const per preview.
 *
 * @example
 * export const BUDGET_PREVIEW = definePreviewData(
 *   { finding: 'FARM-MEDIUM-439', reasonKey: 'finance.budget.previewReason', needs: 'farm-service budget entity + budgetVsActual query' },
 *   [{ centre: 'Hatchery', planned: 120000, spent: 98400 }],
 * );
 */
export function definePreviewData<T>(source: PreviewSource, value: T): PreviewData<T> {
  const handle = new PreviewHandle<T>();
  PREVIEW_ENTRIES.set(handle, {
    source: Object.freeze({ ...source }),
    reveal: (sink: { render(value: T): ReactNode }): ReactNode => sink.render(value),
  });
  return Object.freeze(handle);
}

export interface MockPreviewProps<T> {
  /** A handle from `definePreviewData`. */
  readonly data: PreviewData<T>;
  /**
   * `block` — a notice band above a section (a tab, a table, a chart);
   * `inline` — a focusable MOCK chip beside a single number or cell. The chip
   * is a button, so do not place an inline preview inside another control.
   */
  readonly variant: 'block' | 'inline';
  /** Renders the value; the only place it is reachable. */
  readonly children: (value: T) => ReactNode;
}

/** Render preview data with its notice: the only reader of a preview value. */
export function MockPreview<T>({ data, variant, children }: MockPreviewProps<T>): ReactElement {
  const entry = PREVIEW_ENTRIES.get(data);
  if (entry === undefined) {
    // Only a cast can produce such a handle; failing loudly keeps a forged
    // one from rendering a value with no finding behind it.
    throw new Error('MockPreview: this handle was not created by definePreviewData.');
  }
  const content = entry.reveal({ render: children });
  // createElement rather than JSX keeps the value's owner a plain .ts module.
  return createElement(variant === 'block' ? PreviewNotice : PreviewChip, {
    source: entry.source,
    children: content,
  });
}

/*
 * The handle's opacity, proven by the compiler (FE-MEDIUM-337).
 *
 * WHY here and not in a spec: `expectTypeOf` does nothing at runtime, and
 * tsconfig.json leaves spec files out of `tsc`, so a type assertion in a spec
 * gates nothing. Here every tsc pass over shared-ui checks it — the package
 * build, the platform type-check and CI's changed-file check whenever this
 * file changes — and a change that gives PreviewData a readable member, makes
 * it renderable as a React child, or loosens the render prop's type fails to
 * compile beside that change.
 */
type Holds<Claim extends true> = Claim;
type Not<Claim extends boolean> = Claim extends true ? false : true;
type Extends<A, B> = [A] extends [B] ? true : false;
type Same<A, B> =
  (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false;

/** Compile-time only and read by nothing — exported because an unread local alias fails `noUnusedLocals`. */
export type PreviewDataOpacity = [
  // Not a React child: `{handle}` in JSX does not compile.
  Holds<Not<Extends<PreviewData<string>, ReactNode>>>,
  Holds<Not<Extends<PreviewData<readonly number[]>, ReactNode>>>,
  // No member a page could read: no named field, no string index.
  Holds<Not<Extends<'value', keyof PreviewData<unknown>>>>,
  Holds<Not<Extends<'source', keyof PreviewData<unknown>>>>,
  Holds<Not<Extends<string, keyof PreviewData<unknown>>>>,
  // The render prop receives exactly the value's type.
  Holds<
    Same<
      ReturnType<typeof definePreviewData<{ revision: string }>>,
      PreviewData<{ revision: string }>
    >
  >,
  Holds<
    Same<Parameters<MockPreviewProps<{ revision: string }>['children']>[0], { revision: string }>
  >,
];
