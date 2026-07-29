#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const inventoryPath = path.join(__dirname, 'coverage-report-inventory.json');
const serviceBaselinesPath = path.join(__dirname, 'service-coverage-baselines.json');
const evidencePath = path.join(repoRoot, 'coverage', 'coverage-evidence.json');

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

function verifyCoverage(root = repoRoot) {
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
  const baselines = JSON.parse(fs.readFileSync(serviceBaselinesPath, 'utf8'));
  const reports = [];
  const errors = [];

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
        for (const metric of ['branches', 'functions', 'lines']) {
          if (metrics[metric].percentage < baseline[metric]) {
            errors.push(
              `${reportPath}: ${metric} ${metrics[metric].percentage}% is below ` +
                `${baseline[metric]}%`,
            );
          }
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
  };
}

function main() {
  const evidence = verifyCoverage();
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
};
