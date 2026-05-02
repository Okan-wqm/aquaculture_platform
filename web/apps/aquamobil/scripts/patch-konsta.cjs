#!/usr/bin/env node
/**
 * Patch konsta package.json to add root export.
 *
 * WHY: aquamobil is an ES module package, but postinstall runs in Node before
 * Vite sees the app. Keeping this installer as CommonJS makes dependency
 * installation deterministic under `"type": "module"` instead of failing on
 * `require is not defined`.
 */

const fs = require('fs');
const path = require('path');

const konstaPkgPaths = [
  // Local node_modules
  path.join(__dirname, '..', 'node_modules', 'konsta', 'package.json'),
  // Workspace root node_modules
  path.join(__dirname, '..', '..', '..', '..', 'node_modules', 'konsta', 'package.json'),
];

for (const pkgPath of konstaPkgPaths) {
  try {
    if (!fs.existsSync(pkgPath)) continue;

    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

    // Check if already patched
    if (pkg.exports && pkg.exports['.']) {
      console.log(`✓ konsta already patched at ${pkgPath}`);
      continue;
    }

    // Add root export pointing to react
    pkg.exports = {
      '.': {
        types: './react/konsta-react.d.ts',
        require: './react/cjs/konsta-react.js',
        import: './react/esm/konsta-react.js',
      },
      ...pkg.exports,
    };

    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`✓ Patched konsta at ${pkgPath}`);
  } catch (err) {
    console.warn(`⚠ Could not patch ${pkgPath}: ${err.message}`);
  }
}
