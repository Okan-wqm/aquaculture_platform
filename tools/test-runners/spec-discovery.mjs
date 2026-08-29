import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Discover regular spec files below one runner-owned root.
 *
 * Symlinks are intentionally not traversed: a runner must not escape its
 * declared ownership root, and every returned path is relative to that root.
 */
export function discoverSpecFiles(
  root,
  suffixes,
  { recursive = true } = {},
  directory = root,
  relativeDirectory = '',
) {
  const specs = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = join(relativeDirectory, entry.name);
    if (entry.isDirectory() && recursive) {
      specs.push(
        ...discoverSpecFiles(
          root,
          suffixes,
          { recursive },
          join(directory, entry.name),
          relativePath,
        ),
      );
    } else if (entry.isFile() && suffixes.some((suffix) => entry.name.endsWith(suffix))) {
      specs.push(relativePath);
    }
  }

  return specs.sort();
}
