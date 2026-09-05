import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './canonical.mjs';

const exactDigest = /^[a-f0-9]{64}$/u;

function validFacts(facts) {
  const keys = ['environment_policy', 'executable_sha256', 'logical_name', 'version'];
  return (
    facts !== null &&
    typeof facts === 'object' &&
    !Array.isArray(facts) &&
    JSON.stringify(Object.keys(facts).sort()) === JSON.stringify(keys) &&
    facts.logical_name === 'node' &&
    facts.version === process.version &&
    exactDigest.test(facts.executable_sha256 ?? '') &&
    facts.environment_policy === 'new-aria-hermetic-node-v1'
  );
}

export function materializeVerifiedNode(sourcePath, runtimeRoot, facts) {
  if (!validFacts(facts)) throw new Error('signed Node executable facts are invalid');
  const source = realpathSync(sourcePath);
  if (!lstatSync(source).isFile()) throw new Error('Node executable source must be a real file');
  const directory = join(runtimeRoot, '.runtime');
  const destination = join(directory, 'node');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let copied = false;
  try {
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
    copied = true;
    chmodSync(destination, 0o500);
    if (sha256(readFileSync(destination)) !== facts.executable_sha256) {
      throw new Error('private Node executable digest mismatch');
    }
    return destination;
  } catch (error) {
    if (copied) rmSync(destination, { force: true });
    throw error;
  }
}
