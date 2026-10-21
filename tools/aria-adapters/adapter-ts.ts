#!/usr/bin/env ts-node
/**
 * The TypeScript binding of the one adapter filesystem-containment rule
 * (ARIA-LOW-593).
 *
 * `adapter-fs.ts` owns containment for everything an adapter reads from disk;
 * this module owns the ONE way an adapter builds a `ts.Program` on top of it.
 * Splitting the two files is deliberate, not a second rule: the room walker
 * (`test_adapter_fs_tracked_view`) runs `adapter-fs.ts` alone in a fixture
 * repository with no `node_modules`, so the containment predicate itself must
 * stay importable without paying — or resolving — typescript. Only adapters
 * that actually build a program (tenant-scoping, event-contracts) import this
 * module and load the library, exactly as they already did.
 */
import { relative, resolve } from 'node:path';

import ts from 'typescript';

import { containedWorkspace, normalizeWorkspacePath } from './adapter-fs';

/**
 * A ts.CompilerHost whose filesystem answers go through `containedWorkspace`
 * for every path inside the workspace: readFile, fileExists and
 * directoryExists refuse a path with a symlink on any component, and
 * realpath never resolves a workspace symlink — the path as spelled IS the
 * resolution — so a program built on this host cannot follow a tracked
 * symlink out of the workspace the way the default host (ts.sys) does
 * (ARIA-LOW-593). Paths outside the workspace — the TypeScript library the
 * checker reads its standard types from, a dependency tree the adapter room
 * binds read-only — keep the default host's answers. The overrides are
 * installed on the host object AFTER `createCompilerHost`, which is what
 * makes them bind: TS 5.9's `getSourceFile` reads through
 * `compilerHost.readFile` (a property lookup at call time), and module
 * resolution asks `fileExists`/`directoryExists`/`realpath` the same way.
 */
export function containedCompilerHost(
  workspaceRoot: string,
  options: ts.CompilerOptions,
): ts.CompilerHost {
  const host = ts.createCompilerHost(options);
  const workspace = containedWorkspace(workspaceRoot);
  const root = workspace.root;
  const baseReadFile = host.readFile.bind(host);
  const baseFileExists = host.fileExists.bind(host);
  const baseDirectoryExists = host.directoryExists?.bind(host);
  const baseRealpath = host.realpath?.bind(host);
  const insideWorkspace = (fileName: string): string | null => {
    const relativePath = normalizeWorkspacePath(relative(root, resolve(root, fileName)));
    return relativePath === '' || relativePath.startsWith('../') ? null : relativePath;
  };
  host.readFile = (fileName) => {
    const relativePath = insideWorkspace(fileName);
    if (relativePath === null) return baseReadFile(fileName);
    try {
      return workspace.readFile(relativePath);
    } catch {
      // A path containment refuses is an unreadable module, exactly as a
      // missing one: the program reports it unresolved, never read.
      return undefined;
    }
  };
  host.fileExists = (fileName) => {
    const relativePath = insideWorkspace(fileName);
    return relativePath === null
      ? baseFileExists(fileName)
      : workspace.entry(relativePath) === 'file';
  };
  host.directoryExists = (fileName) => {
    const relativePath = insideWorkspace(fileName);
    if (relativePath === null) return baseDirectoryExists?.(fileName) ?? false;
    return workspace.entry(relativePath) === 'directory';
  };
  host.realpath = (fileName) => {
    const relativePath = insideWorkspace(fileName);
    return relativePath === null ? (baseRealpath?.(fileName) ?? fileName) : fileName;
  };
  return host;
}

/**
 * The one way an adapter builds a ts.Program: on `containedCompilerHost`, so
 * every module the program reads — the walked files and whatever they import
 * from inside the workspace — is read through containment, and nothing
 * behind a workspace symlink is ever resolved (ARIA-LOW-593). The shared
 * compiler options (one copy, this owner) are the adapters' analysis
 * settings; `extraOptions` adds what a specific adapter's language surface
 * needs (tenant-scoping's decorators), and cannot weaken containment.
 */
export function createContainedProgram(
  workspaceRoot: string,
  files: readonly string[],
  extraOptions?: ts.CompilerOptions,
): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    esModuleInterop: true,
    skipLibCheck: true,
    strict: false,
    noEmit: true,
    ...extraOptions,
  };
  return ts.createProgram([...files], options, containedCompilerHost(workspaceRoot, options));
}
