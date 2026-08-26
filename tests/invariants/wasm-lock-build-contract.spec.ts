import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WASM_BINDGEN_VERSION = '0.2.127';

const CONTRACTS = [
  {
    name: 'alarm-core',
    project: 'libs/alarm-core/project.json',
    manifest: 'crates/alarm-core-wasm/Cargo.toml',
    lock: 'crates/alarm-core-wasm/Cargo.lock',
    script: 'libs/alarm-core/scripts/build-wasm.sh',
  },
  {
    name: 'protocol-codec',
    project: 'libs/protocol-codec/project.json',
    manifest: 'crates/protocol-codec-wasm/Cargo.toml',
    lock: 'crates/protocol-codec-wasm/Cargo.lock',
    script: 'libs/protocol-codec/scripts/build-wasm.sh',
  },
] as const;

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

describe('standalone WASM lock/build contract', () => {
  test.each(CONTRACTS)('$name pins one binding toolchain and consumes its lock', (contract) => {
    const project = JSON.parse(read(contract.project)) as {
      targets?: { 'build-wasm'?: { inputs?: string[] } };
    };
    const manifest = read(contract.manifest);
    const lock = read(contract.lock);
    const script = read(contract.script);

    expect(project.targets?.['build-wasm']?.inputs).toContain(`{workspaceRoot}/${contract.lock}`);
    expect(manifest).toContain(`wasm-bindgen = "=${WASM_BINDGEN_VERSION}"`);
    expect(manifest).toMatch(/^\[workspace\]\s*$/m);
    expect(lock).toContain(`name = "wasm-bindgen"\nversion = "${WASM_BINDGEN_VERSION}"`);
    expect(script).toContain(`WASM_BINDGEN_VERSION="${WASM_BINDGEN_VERSION}"`);
    expect(script).toContain('wasm-bindgen --version');
    expect(script).toContain('cargo build --locked --target wasm32-unknown-unknown --release');
  });
});
