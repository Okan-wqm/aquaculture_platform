import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

function contained(root, candidate) {
  const offset = relative(root, candidate);
  return offset === '' || (!offset.startsWith('..') && !isAbsolute(offset));
}

export function walkRegularFiles(root) {
  const lexicalRoot = realpathSync(root);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('tree root must be a real directory');
  }
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`${path}: symbolic link is forbidden`);
      const real = realpathSync(path);
      if (!contained(lexicalRoot, real)) throw new Error(`${path}: escapes tree root`);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files.push(path);
      else throw new Error(`${path}: must be a regular file or directory`);
    }
  }
  visit(root);
  return files;
}
