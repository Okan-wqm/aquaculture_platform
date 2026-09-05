// Precision, recall and scale of the mechanical layer, measured against the
// legal instance's labelled corpus and its release thresholds.
//
// WHY: `arias/legal/aria.manifest.json` declares `precision_min: 1.0` and
// `critical_false_positives_max: 0`. MEASURED 2026-09-04: nothing measured
// either, and the contradiction pass had only ever run on the fixture it was
// built against; on 400 unrelated letters it produced 237,880 false disputes
// and the kernel discarded the run for size. A threshold that no test compares
// against is a sentence in a file. This test IS the comparison: the corpus
// plants disagreements and missing documents with labels, the adapter runs
// over each case, and precision and recall are counted and gated.
//
// WHAT: node:test cases. Run from `new-aria/`:
//   npx ts-node --project tools/gates/tsconfig.json packs/legal/adapters/records/precision.test.ts
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { runLegalDocumentInventory } from '../legal-document-inventory';
import { MAX_FINDINGS_PER_RUN, MAX_STATEMENTS_PER_RUN } from '../legal-records';

const WORKSPACE_ROOT = resolve(__dirname, '..', '..', '..', '..');
const INSTANCE_ROOT = resolve(WORKSPACE_ROOT, 'arias', 'legal');

interface CorpusCase {
  readonly id: string;
  readonly archive: string;
  readonly expected: {
    readonly contradictions: ReadonlyArray<{ readonly labelKey: string; readonly kind: 'date' | 'amount'; readonly left: string; readonly right: string; readonly anchor: string }>;
    readonly missing: ReadonlyArray<{ readonly kind: string; readonly identifier: string }>;
  };
}

interface Corpus {
  readonly cases: ReadonlyArray<CorpusCase>;
}

interface Manifest {
  readonly evaluations: { readonly corpus: string; readonly release_thresholds: { readonly precision_min: number; readonly critical_false_positives_max: number } };
}

const MANIFEST = JSON.parse(readFileSync(resolve(INSTANCE_ROOT, 'aria.manifest.json'), 'utf8')) as Manifest;
const CORPUS_ROOT = resolve(INSTANCE_ROOT, MANIFEST.evaluations.corpus);
const CORPUS = JSON.parse(readFileSync(resolve(CORPUS_ROOT, 'corpus.json'), 'utf8')) as Corpus;

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `aria-legal-precision-${label}-`));
}

/** The contradiction findings of a run, keyed the way the corpus labels them. */
function foundContradictions(findings: ReadonlyArray<{ readonly id: string; readonly rule: string }>): Set<string> {
  const out = new Set<string>();
  for (const finding of findings) {
    if (finding.rule !== 'date_contradiction' && finding.rule !== 'amount_contradiction') continue;
    // id = `<adapter>:<kind>-contradiction:<labelKey>:<leftPath>:<rightPath>`
    const parts = finding.id.split(':');
    const kind = (parts[1] ?? '').replace('-contradiction', '');
    const labelKey = parts[2] ?? '';
    const left = parts[3] ?? '';
    const right = parts[4] ?? '';
    out.add(`${kind}|${labelKey}|${left}|${right}`);
  }
  return out;
}

function foundMissing(findings: ReadonlyArray<{ readonly id: string; readonly rule: string }>): Set<string> {
  const out = new Set<string>();
  for (const finding of findings) {
    if (finding.rule !== 'missing_evidence') continue;
    // id = `<adapter>:missing-evidence:<kind>:<identifier>`
    const parts = finding.id.split(':');
    out.add(`${parts[2] ?? ''}|${parts[3] ?? ''}`);
  }
  return out;
}

test('the corpus is present, labelled and generated (no hand edits)', () => {
  assert.ok(CORPUS.cases.length >= 3, 'the corpus plants at least an unrelated set, an anchored dispute and missing documents');
  for (const item of CORPUS.cases) {
    assert.ok(readFileSync(resolve(CORPUS_ROOT, item.archive, item.id === 'missing-docs' ? 'brev_1.txt' : item.id === 'anchored-dispute' ? 'klage.txt' : 'faktura_2024-001.txt')).length > 0, `${item.id}: archive present`);
  }
});

test('precision and recall over the labelled corpus meet the release thresholds the manifest declares', () => {
  const threshold = MANIFEST.evaluations.release_thresholds;
  let truePositives = 0;
  let falsePositives = 0;
  let expectedTotal = 0;
  const report: string[] = [];
  for (const item of CORPUS.cases) {
    const result = runLegalDocumentInventory({ archive_root: resolve(CORPUS_ROOT, item.archive), case_id: `corpus-${item.id}`, out_dir: tempDir(item.id) });
    assert.ok(result.artifacts, `${item.id}: the run produced artifacts`);
    const contradictions = foundContradictions(result.output.findings);
    // Finding ids carry the paths relative to the archive, as the corpus labels them.
    const expectedContradictions = new Set(item.expected.contradictions.map((row) => `${row.kind}|${row.labelKey}|${row.left}|${row.right}`));
    for (const key of contradictions) {
      if (expectedContradictions.has(key)) truePositives += 1;
      else {
        falsePositives += 1;
        report.push(`${item.id}: unexpected contradiction ${key}`);
      }
    }
    for (const key of expectedContradictions) {
      expectedTotal += 1;
      if (!contradictions.has(key)) report.push(`${item.id}: missed contradiction ${key}`);
    }
    const missing = foundMissing(result.output.findings);
    const expectedMissing = new Set(item.expected.missing.map((row) => `${row.kind}|${row.identifier}`));
    for (const key of missing) {
      if (expectedMissing.has(key)) truePositives += 1;
      else {
        falsePositives += 1;
        report.push(`${item.id}: unexpected missing-evidence ${key}`);
      }
    }
    for (const key of expectedMissing) {
      expectedTotal += 1;
      if (!missing.has(key)) report.push(`${item.id}: missed missing-evidence ${key}`);
    }
    // The anchor the corpus labels must be the anchor the row carries.
    for (const row of item.expected.contradictions) {
      const statement = result.artifacts.statements.find((candidate) => candidate.status === 'disputed' && candidate.statement.includes(row.left) && candidate.statement.includes(row.right));
      assert.ok(statement, `${item.id}: the disputed row for ${row.labelKey} is in the matrix`);
      assert.ok(statement.humanReviewRequired && statement.verifiedBy === null);
    }
  }
  const precision = truePositives + falsePositives === 0 ? 1 : truePositives / (truePositives + falsePositives);
  const recall = expectedTotal === 0 ? 1 : truePositives / expectedTotal;
  assert.deepEqual(report, [], report.join('\n'));
  assert.ok(precision >= threshold.precision_min, `precision ${precision} < precision_min ${threshold.precision_min}`);
  assert.ok(falsePositives <= threshold.critical_false_positives_max, `${falsePositives} false positives > ${threshold.critical_false_positives_max}`);
  assert.equal(recall, 1, `every planted disagreement and missing document is found (recall ${recall})`);
  // Report the figures where a CI log can read them.
  process.stdout.write(`# legal corpus: cases=${CORPUS.cases.length} expected=${expectedTotal} tp=${truePositives} fp=${falsePositives} precision=${precision.toFixed(3)} recall=${recall.toFixed(3)}\n`);
});

test('3,000 documents run inside the kernel budgets, and an anchored cluster costs one row per distinct value', () => {
  const archive = tempDir('scale-archive');
  const count = 3000;
  mkdirSync(archive, { recursive: true });
  writeFileSync(join(archive, 'avtale_2024-01-15.txt'), ['AVTALE', 'Dato: 15.01.2024', 'Kontraktssum: NOK 4 950 000,00', ''].join('\n'), 'utf8');
  for (let index = 0; index < count; index += 1) {
    const number = String(index + 1).padStart(5, '0');
    const lines = [`Brev nr. ${number}`, `Dato: ${String(1 + (index % 28)).padStart(2, '0')}.0${1 + (index % 9)}.2024`, `Beløp: NOK ${100000 + index},00`];
    // Every tenth letter cites the agreement and states its own idea of the
    // contract sum: one anchored cluster of 300 documents.
    if (index % 10 === 0) lines.push('Vi viser til avtale av 15.01.2024.', `Kontraktssum: NOK ${4950000 + (index % 50) * 1000},00`);
    lines.push('');
    writeFileSync(join(archive, `brev_${number}.txt`), lines.join('\n'), 'utf8');
  }
  const started = Date.now();
  const result = runLegalDocumentInventory({ archive_root: archive, case_id: 'scale-3000', out_dir: tempDir('scale-out') });
  const elapsedMs = Date.now() - started;
  assert.ok(result.artifacts);
  const stdoutBytes = Buffer.byteLength(JSON.stringify(result.output), 'utf8');
  assert.ok(elapsedMs < 300_000, `run took ${elapsedMs} ms, over the kernel's 300 s timeout`);
  assert.ok(stdoutBytes < 12 * 1024 * 1024, `stdout ${stdoutBytes} bytes, over the kernel's 12 MiB cap`);
  assert.equal(result.artifacts.coverage.totalFiles, count + 1);
  // 300 letters cite the agreement, which IS in the archive and states its
  // contract sum. The letters state five distinct sums, one equal to the
  // agreement's: four disagreements with the subject, never 44,850 pairs. Their
  // own `Beløp` is each letter's fact, not a claim about the agreement, which
  // states no Beløp at all — so it yields nothing.
  const contradictions = result.output.findings.filter((finding) => finding.rule === 'amount_contradiction');
  assert.equal(contradictions.length, 4, `${contradictions.length} contradiction rows: expected the four sums that differ from the agreement's`);
  assert.ok(contradictions.every((finding) => finding.evidence[0]?.path.endsWith('avtale_2024-01-15.txt')), 'every row is the subject against a citing letter');
  // Unanchored letters, each with its own Beløp and Dato, produce nothing.
  assert.equal(result.output.findings.filter((finding) => finding.rule === 'date_contradiction').length, 0);
  assert.ok(result.artifacts.statements.length <= MAX_STATEMENTS_PER_RUN);
  assert.ok(result.output.findings.length <= MAX_FINDINGS_PER_RUN);
  assert.deepEqual(result.artifacts.coverage.truncated, { findings: 0, statements: 0, timeline: 0 });
  process.stdout.write(`# legal scale: files=${count + 1} ms=${elapsedMs} stdoutBytes=${stdoutBytes} contradictions=${contradictions.length} statements=${result.artifacts.statements.length} events=${result.artifacts.timeline.length}\n`);
});
