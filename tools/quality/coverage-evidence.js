#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const inventoryPath = path.join(__dirname, 'coverage-report-inventory.json');
const serviceBaselinesPath = path.join(__dirname, 'service-coverage-baselines.json');
const evidencePath = path.join(repoRoot, 'coverage', 'coverage-evidence.json');

const METRICS = ['branches', 'functions', 'lines'];
// Coverage jitters by fractions of a point between runs (worker counts,
// parallel shards). One point is the smallest gain that is a change in the
// code rather than in the weather.
const RATCHET_MIN_GAIN = 1.0;

function percentage(covered, found) {
  return found === 0 ? 100 : Number(((covered / found) * 100).toFixed(2));
}

function parseLcov(content, reportPath) {
  const totals = {
    branches: { covered: 0, found: 0 },
    functions: { covered: 0, found: 0 },
    lines: { covered: 0, found: 0 },
  };
  let sourceFiles = 0;

  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith('SF:')) sourceFiles += 1;
    if (line.startsWith('BRH:')) totals.branches.covered += Number(line.slice(4));
    if (line.startsWith('BRF:')) totals.branches.found += Number(line.slice(4));
    if (line.startsWith('FNH:')) totals.functions.covered += Number(line.slice(4));
    if (line.startsWith('FNF:')) totals.functions.found += Number(line.slice(4));
    if (line.startsWith('LH:')) totals.lines.covered += Number(line.slice(3));
    if (line.startsWith('LF:')) totals.lines.found += Number(line.slice(3));
  }

  if (sourceFiles === 0 || totals.lines.found === 0) {
    throw new Error(`${reportPath}: LCOV contains no instrumented source lines`);
  }

  return {
    source_files: sourceFiles,
    branches: {
      ...totals.branches,
      percentage: percentage(totals.branches.covered, totals.branches.found),
    },
    functions: {
      ...totals.functions,
      percentage: percentage(totals.functions.covered, totals.functions.found),
    },
    lines: {
      ...totals.lines,
      percentage: percentage(totals.lines.covered, totals.lines.found),
    },
  };
}

function serviceNameForReport(reportPath) {
  const match = /^coverage\/apps\/([^/]+)\/lcov\.info$/.exec(reportPath);
  return match?.[1];
}

function verifyCoverage(root = repoRoot, { rewrite = false } = {}) {
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
  const baselines = JSON.parse(fs.readFileSync(serviceBaselinesPath, 'utf8'));
  const reports = [];
  const errors = [];
  const ratchet = [];

  if (inventory.schema_version !== 1 || !Array.isArray(inventory.reports)) {
    throw new Error('coverage report inventory must use schema_version 1 with a reports array');
  }

  const uniqueReports = new Set(inventory.reports);
  if (uniqueReports.size !== inventory.reports.length) {
    errors.push('coverage report inventory contains duplicate paths');
  }
  if ([...uniqueReports].some((entry) => path.isAbsolute(entry) || entry.includes('..'))) {
    errors.push('coverage report inventory paths must be repository-relative and traversal-free');
  }

  for (const reportPath of [...uniqueReports].sort()) {
    const absolutePath = path.join(root, reportPath);
    if (!fs.existsSync(absolutePath)) {
      errors.push(`${reportPath}: expected report is missing`);
      continue;
    }

    const content = fs.readFileSync(absolutePath, 'utf8');
    try {
      const metrics = parseLcov(content, reportPath);
      const serviceName = serviceNameForReport(reportPath);
      const baseline = serviceName ? baselines[serviceName] : undefined;

      if (baseline) {
        for (const metric of METRICS) {
          if (metrics[metric].percentage < baseline[metric]) {
            errors.push(
              `${reportPath}: ${metric} ${metrics[metric].percentage}% is below ` +
                `${baseline[metric]}%`,
            );
          }
        }
        // The floor only ever looked DOWN. A service whose coverage rose kept
        // the old pin, so the improvement was never captured and the next
        // change could eat it back in silence — the ratchet had a pawl on one
        // side only. Material improvement (>= RATCHET_MIN_GAIN points, so
        // run-to-run jitter does not red the build) must be re-pinned.
        const gains = METRICS.filter(
          (metric) => pinnableFloor(metrics[metric]) - baseline[metric] >= RATCHET_MIN_GAIN,
        );
        if (gains.length > 0 && !rewrite) {
          ratchet.push({ serviceName, metrics });
          errors.push(
            `${reportPath}: coverage ROSE and the baseline was left behind — ` +
              gains
                .map((metric) => `${metric} ${baseline[metric]}% -> ${metrics[metric].percentage}%`)
                .join(', ') +
              `. Re-pin it: node tools/quality/coverage-evidence.js --write`,
          );
        }
        if (gains.length > 0 && rewrite) {
          ratchet.push({ serviceName, metrics });
        }
      }

      reports.push({
        path: reportPath,
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
        bytes: Buffer.byteLength(content),
        ...metrics,
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (errors.length > 0) {
    throw new Error(`coverage evidence contract failed:\n- ${errors.join('\n- ')}`);
  }

  return {
    schema_version: 1,
    commit_sha: process.env.GITHUB_SHA || null,
    report_count: reports.length,
    reports,
    ratchet,
  };
}

/**
 * The pin must be a number the gate that enforces it can actually MEET.
 * `percentage()` rounds half-up for reporting; jest truncates when it checks
 * `coverageThreshold`. Pinning the reported value therefore produces a floor
 * 0.01 above the measurement — observed on the ratchet's first re-pin, where
 * four services failed by exactly one hundredth ("threshold for branches
 * (15.99%) not met: 15.98%"). Flooring the raw ratio makes the pin reachable
 * by construction, and costs at most 0.01 of captured gain.
 */
function pinnableFloor(metric) {
  if (metric.found === 0) return 100;
  return Math.floor((metric.covered / metric.found) * 10000) / 100;
}

/** Raise pinned baselines to the measured values. NEVER lowers one. */
function rewriteBaselines(ratchet) {
  const baselines = JSON.parse(fs.readFileSync(serviceBaselinesPath, 'utf8'));
  const raised = [];
  for (const { serviceName, metrics } of ratchet) {
    const current = baselines[serviceName];
    if (!current) continue;
    for (const metric of METRICS) {
      const measured = pinnableFloor(metrics[metric]);
      // Monotonic by construction: a lower measurement is already an error
      // above, and --write must never be the way a floor gets lowered.
      if (measured > current[metric]) {
        raised.push(`${serviceName}.${metric} ${current[metric]} -> ${measured}`);
        current[metric] = measured;
      }
    }
  }
  if (raised.length > 0) {
    fs.writeFileSync(serviceBaselinesPath, `${JSON.stringify(baselines, null, 2)}\n`, 'utf8');
  }
  return raised;
}

function main() {
  const rewrite = process.argv.includes('--write');
  const evidence = verifyCoverage(repoRoot, { rewrite });
  if (rewrite) {
    const raised = rewriteBaselines(evidence.ratchet);
    console.log(
      raised.length > 0
        ? `coverage baselines raised: ${raised.join(', ')}`
        : 'coverage baselines: already current',
    );
  }
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(
    `coverage-evidence: ${evidence.report_count} reports verified; ` +
      `${path.relative(repoRoot, evidencePath)} written`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  parseLcov,
  verifyCoverage,
  rewriteBaselines,
  pinnableFloor,
  RATCHET_MIN_GAIN,
};
