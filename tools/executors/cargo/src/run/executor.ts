import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

// Minimal Nx executor surface. Avoids importing @nx/devkit to keep this
// executor's dependency footprint to zero — matches eslint-rules workspace
// posture (only typescript devDep).
export interface ExecutorContext {
    root: string;
    projectName?: string;
    workspace?: { version: number };
    cwd?: string;
    isVerbose?: boolean;
}

export interface CargoRunOptions {
    command: 'build' | 'test' | 'clippy' | 'fmt' | 'check' | 'bench' | 'run';
    package: string;
    release?: boolean;
    allFeatures?: boolean;
    noDefaultFeatures?: boolean;
    features?: string[];
    args?: string[];
    env?: Record<string, string>;
}

const TERMINATING_FLAGS = new Set(['--', '-D']);

function buildCargoArgs(opts: CargoRunOptions): string[] {
    const cargoArgs: string[] = [opts.command];

    cargoArgs.push('-p', opts.package);

    if (opts.release && opts.command !== 'fmt' && opts.command !== 'clippy') {
        cargoArgs.push('--release');
    }

    if (opts.allFeatures) {
        cargoArgs.push('--all-features');
    }

    if (opts.noDefaultFeatures) {
        cargoArgs.push('--no-default-features');
    }

    if (opts.features && opts.features.length > 0) {
        cargoArgs.push('--features', opts.features.join(','));
    }

    if (opts.args && opts.args.length > 0) {
        // Caller-provided trailing args (e.g. `--`, `-- --check`, `-- -D warnings`)
        // are appended verbatim. The executor does not try to second-guess
        // cargo's argv parser; if the caller supplies a `--` they own ordering.
        cargoArgs.push(...opts.args);
    }

    return cargoArgs;
}

export default async function cargoRun(
    options: CargoRunOptions,
    context: ExecutorContext,
): Promise<{ success: boolean }> {
    if (!options.command || !options.package) {
        // Fail fast — schema.json should already enforce this, but the
        // executor is the last line of defense for typed call-sites that
        // bypass schema validation.
        process.stderr.write(
            `[@aqua/cargo:run] Missing required option(s); command='${options.command}' package='${options.package}'\n`,
        );
        return { success: false };
    }

    const workspaceRoot = resolve(context.root ?? process.cwd());
    const cargoArgs = buildCargoArgs(options);
    const env = { ...process.env, ...(options.env ?? {}) };

    if (context.isVerbose) {
        process.stderr.write(
            `[@aqua/cargo:run] cwd=${workspaceRoot} cargo ${cargoArgs.join(' ')}\n`,
        );
    }

    return new Promise((resolveResult) => {
        const child = spawn('cargo', cargoArgs, {
            cwd: workspaceRoot,
            env,
            stdio: 'inherit',
        });

        child.on('error', (err) => {
            // Most common case: cargo not on PATH. Surface a hint so CI logs
            // are self-explanatory without sending the engineer hunting.
            process.stderr.write(
                `[@aqua/cargo:run] Failed to spawn cargo: ${err.message}\n` +
                    `Hint: install via rustup (https://rustup.rs) or use the rust-toolchain.toml at the workspace root.\n`,
            );
            resolveResult({ success: false });
        });

        child.on('exit', (code) => {
            const success = code === 0;
            if (!success && !context.isVerbose) {
                process.stderr.write(
                    `[@aqua/cargo:run] cargo ${cargoArgs.join(' ')} exited with code ${code ?? 'null'}\n`,
                );
            }
            resolveResult({ success });
        });
    });
}

// Re-export sentinel for tests that want to inspect the trailing-args contract
// without spawning cargo.
export const __TEST_HELPERS__ = { buildCargoArgs, TERMINATING_FLAGS };
