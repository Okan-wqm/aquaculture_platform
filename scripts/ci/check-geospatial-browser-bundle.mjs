#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const repoRoot = process.cwd();
const scanRoots = [
  {
    label: 'farm-module source',
    path: resolve(repoRoot, 'web/modules/farm-module/src'),
    required: true,
  },
  {
    label: 'farm-module dist',
    path: resolve(repoRoot, 'web/modules/farm-module/dist'),
    required: false,
  },
];

const forbiddenPatterns = [
  {
    id: 'direct-cdse-process',
    pattern: /sh\.dataspace\.copernicus\.eu/i,
    message: 'Browser bundle must not call Copernicus Data Space directly.',
  },
  {
    id: 'direct-cmems-wmts',
    pattern: /wmts\.marine\.copernicus\.eu/i,
    message: 'Browser bundle must not call CMEMS WMTS directly.',
  },
  {
    id: 'legacy-sentinel-route',
    pattern: /\/api\/sentinel-hub\b/i,
    message: 'Browser bundle must use /api/marine, not the legacy Sentinel proxy route.',
  },
  {
    id: 'deleted-sentinel-tile-service',
    pattern: /sentinelTileService/i,
    message: 'Deleted Sentinel tile service must not be imported or referenced.',
  },
  {
    id: 'frontend-owned-cmems-url-builder',
    pattern: /getCMEMSWMTSTileUrl|CMEMS_WMTS/i,
    message: 'CMEMS URL construction belongs to the backend marine data module.',
  },
  {
    id: 'frontend-owned-cmems-point-query',
    pattern: /getCMEMSPointValue|GetFeatureInfo/i,
    message: 'CMEMS point queries belong to the backend marine data module.',
  },
];

const allowedExtensions = new Set([
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.css',
  '.html',
  '.json',
  '.map',
]);

function extensionOf(path) {
  const index = path.lastIndexOf('.');
  return index === -1 ? '' : path.slice(index);
}

function listFiles(root) {
  const entries = readdirSync(root);
  const files = [];
  for (const entry of entries) {
    const absolute = join(root, entry);
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      files.push(...listFiles(absolute));
      continue;
    }
    if (stat.isFile() && allowedExtensions.has(extensionOf(entry))) {
      files.push(absolute);
    }
  }
  return files;
}

const violations = [];

for (const scanRoot of scanRoots) {
  if (!existsSync(scanRoot.path)) {
    if (scanRoot.required) {
      violations.push({
        root: scanRoot.label,
        file: relative(repoRoot, scanRoot.path),
        patternId: 'missing-required-root',
        message: 'Required geospatial scan root is missing.',
      });
    }
    continue;
  }

  for (const file of listFiles(scanRoot.path)) {
    const content = readFileSync(file, 'utf8');
    for (const forbidden of forbiddenPatterns) {
      if (forbidden.pattern.test(content)) {
        violations.push({
          root: scanRoot.label,
          file: relative(repoRoot, file),
          patternId: forbidden.id,
          message: forbidden.message,
        });
      }
    }
  }
}

if (violations.length > 0) {
  process.stderr.write('Geospatial browser bundle SSoT gate failed:\n');
  for (const violation of violations) {
    process.stderr.write(
      `- [${violation.patternId}] ${violation.file} (${violation.root}): ${violation.message}\n`,
    );
  }
  process.exit(1);
}

process.stdout.write('Geospatial browser bundle SSoT gate passed.\n');
