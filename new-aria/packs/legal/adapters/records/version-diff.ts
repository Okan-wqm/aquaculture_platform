// What changed between two versions of the same document.
//
// WHY: "which draft is this and what moved between them" is the question a
// version group raises and does not answer. Today the pack says two files are
// versions of each other and stops; a lawyer still has to open both and read.
// The answer is mechanical — the texts are already extracted, and a line diff
// plus a comparison of the values each version states under the same label is
// arithmetic, not judgement. Doing it here rather than asking a model means the
// change list is reproducible and every entry quotes the two versions' own words.
//
// WHAT: `diffVersions(previous, next)` returns the labelled values that changed,
// the lines added and the lines removed, using a plain longest-common-subsequence
// over lines. Nothing here decides which version is authoritative: that is a
// lawyer's declaration (approval class `filed_version_declaration`), never a
// derived fact.
import { byteCompare, collapseWhitespace } from '../legal-text';
import type { LabelledFact } from './fact-index';

/** A value both versions state under one label, with different content. */
export interface ChangedValue {
  readonly label: string;
  readonly labelKey: string;
  readonly kind: 'date' | 'amount';
  readonly from: string;
  readonly to: string;
  /** Where each version says it, so a reader can open both. */
  readonly fromLocator: string;
  readonly toLocator: string;
}

/** A value one version states and the other does not mention at all. */
export interface DroppedOrAddedValue {
  readonly label: string;
  readonly labelKey: string;
  readonly kind: 'date' | 'amount';
  readonly value: string;
  readonly locator: string;
}

export interface VersionDiff {
  readonly changedValues: readonly ChangedValue[];
  readonly addedValues: readonly DroppedOrAddedValue[];
  readonly removedValues: readonly DroppedOrAddedValue[];
  readonly addedLines: readonly string[];
  readonly removedLines: readonly string[];
  /** Lines both versions carry, unchanged. A ratio a reader can weigh the rest against. */
  readonly unchangedLines: number;
}

/** Text side of one version. */
export interface VersionSide {
  readonly text: string;
  readonly facts: readonly LabelledFact[];
}

/**
 * Bound on the diff. Two 10k-line documents would be 100M cells; a legal
 * archive can hold such a file, and a run that hangs on one document is worse
 * than one that says it did not compare that pair.
 */
const MAX_DIFF_LINES = 4000;

function meaningfulLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => collapseWhitespace(line))
    .filter((line) => line.length > 0 && !/^\f?\[page \d+\]$/.test(line));
}

/**
 * Longest common subsequence over lines, returning the indices kept on each side.
 *
 * Written out rather than pulled in because it is twenty lines and a legal
 * evidence tool should not take a dependency to compare two lists of strings.
 */
function commonLines(previous: readonly string[], next: readonly string[]): { keptPrevious: Set<number>; keptNext: Set<number> } {
  const rows = previous.length;
  const columns = next.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(columns + 1).fill(0));
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      const current = table[row] as number[];
      const below = table[row + 1] as number[];
      current[column] = previous[row] === next[column] ? (below[column + 1] as number) + 1 : Math.max(below[column] as number, current[column + 1] as number);
    }
  }
  const keptPrevious = new Set<number>();
  const keptNext = new Set<number>();
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (previous[row] === next[column]) {
      keptPrevious.add(row);
      keptNext.add(column);
      row += 1;
      column += 1;
      continue;
    }
    const below = table[row + 1] as number[];
    const current = table[row] as number[];
    if ((below[column] as number) >= (current[column + 1] as number)) row += 1;
    else column += 1;
  }
  return { keptPrevious, keptNext };
}

function factKey(fact: LabelledFact): string {
  return `${fact.kind}\n${fact.labelKey}`;
}

/** First occurrence per (kind, label): a restated value is layout, not a second fact. */
function firstByLabel(facts: readonly LabelledFact[]): Map<string, LabelledFact> {
  const out = new Map<string, LabelledFact>();
  for (const fact of facts) {
    const key = factKey(fact);
    if (!out.has(key)) out.set(key, fact);
  }
  return out;
}

export function diffVersions(previous: VersionSide, next: VersionSide): VersionDiff {
  const previousFacts = firstByLabel(previous.facts);
  const nextFacts = firstByLabel(next.facts);

  const changedValues: ChangedValue[] = [];
  const removedValues: DroppedOrAddedValue[] = [];
  for (const [key, fact] of previousFacts) {
    const counterpart = nextFacts.get(key);
    if (counterpart === undefined) {
      removedValues.push({ label: fact.label, labelKey: fact.labelKey, kind: fact.kind, value: fact.value, locator: fact.locator });
      continue;
    }
    if (counterpart.value === fact.value) continue;
    changedValues.push({
      label: fact.label,
      labelKey: fact.labelKey,
      kind: fact.kind,
      from: fact.value,
      to: counterpart.value,
      fromLocator: fact.locator,
      toLocator: counterpart.locator,
    });
  }
  const addedValues: DroppedOrAddedValue[] = [];
  for (const [key, fact] of nextFacts) {
    if (previousFacts.has(key)) continue;
    addedValues.push({ label: fact.label, labelKey: fact.labelKey, kind: fact.kind, value: fact.value, locator: fact.locator });
  }

  const previousLines = meaningfulLines(previous.text);
  const nextLines = meaningfulLines(next.text);
  if (previousLines.length > MAX_DIFF_LINES || nextLines.length > MAX_DIFF_LINES) {
    // The value comparison above is linear and still stands; only the line diff
    // is skipped, and the empty line lists say so by carrying no entries while
    // unchangedLines reports -1 rather than a made-up count.
    return {
      changedValues: changedValues.sort((a, b) => byteCompare(a.labelKey, b.labelKey)),
      addedValues: addedValues.sort((a, b) => byteCompare(a.labelKey, b.labelKey)),
      removedValues: removedValues.sort((a, b) => byteCompare(a.labelKey, b.labelKey)),
      addedLines: [],
      removedLines: [],
      unchangedLines: -1,
    };
  }
  const { keptPrevious, keptNext } = commonLines(previousLines, nextLines);
  return {
    changedValues: changedValues.sort((a, b) => byteCompare(a.labelKey, b.labelKey)),
    addedValues: addedValues.sort((a, b) => byteCompare(a.labelKey, b.labelKey)),
    removedValues: removedValues.sort((a, b) => byteCompare(a.labelKey, b.labelKey)),
    removedLines: previousLines.filter((_line, index) => !keptPrevious.has(index)),
    addedLines: nextLines.filter((_line, index) => !keptNext.has(index)),
    unchangedLines: keptPrevious.size,
  };
}
