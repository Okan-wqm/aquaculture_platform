#!/usr/bin/env ts-node
/**
 * The TypeScript binding of the one adapter filesystem-containment rule
 * (ARIA-LOW-593).
 *
 * `adapter-fs.ts` owns containment for everything an adapter reads from disk;
 * this module owns the ONE way a ts.CompilerHost is built on top of it, for
 * the adapters and for the code-fact scans of tools/gates alike.
 * Splitting the two files is deliberate, not a second rule: the room walker
 * (`test_adapter_fs_tracked_view`) runs `adapter-fs.ts` alone in a fixture
 * repository with no `node_modules`, so the containment predicate itself must
 * stay importable without paying — or resolving — typescript. Only modules
 * that actually build a program (tenant-scoping, event-contracts, the
 * event-consumer index) import this module and load the library.
 */
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import ts from 'typescript';

import { containedWorkspace, normalizeWorkspacePath } from './adapter-fs';

/**
 * The tracked content of a tree, as the tracked view asks it: `TrackedTree`
 * (tools/gates/event-consumer-index.ts) is the one implementation. Paths are
 * repo-relative and posix; a path is held only when it is tracked and every
 * component of it is a real directory, the last a regular file (or, for a
 * directory, a real directory holding a tracked path), classified through
 * `containedWorkspace`.
 */
export interface TrackedContent {
  /** The tree's absolute root. */
  readonly root: string;
  holdsFile(path: string): boolean;
  holdsDirectory(path: string): boolean;
}

/**
 * What of the tree a compiler host may see. It is required: no host is built
 * without naming its view, and neither view falls back to the other.
 *
 *  - `contained`: every regular file and directory reached from the workspace
 *    without crossing a symlink (`containedWorkspace`), ignored and untracked
 *    files included; outside the workspace the default host's answers (the
 *    TypeScript library, a dependency tree the adapter room binds).
 *    tenant-scoping reads this view: its fixtures are plain directories, not
 *    git work trees.
 *  - `tracked`: inside the tree only its tracked content (`TrackedContent`);
 *    under the tree's node_modules and outside the tree only the installed
 *    toolchain: that node_modules (and where it links to) and the running
 *    compiler's lib directory. An import of an ignored, untracked, symlinked
 *    or absolute-path module resolves to nothing (SE-3-R2 round-2 RB). The
 *    event-contracts adapter and the code-fact scans read this view, so the
 *    one definition rule (`eventDefinitionsIn`) answers over one view for
 *    both (SE-3-R2 appellate RC).
 */
export type InTreeView =
  | { readonly kind: 'contained'; readonly workspaceRoot: string }
  | { readonly kind: 'tracked'; readonly tree: TrackedContent };

/** The filesystem questions a compiler host answers, as one view answers them. */
interface ViewAnswers {
  readonly readFile: (path: string) => string | undefined;
  readonly fileExists: (path: string) => boolean;
  readonly directoryExists: (path: string) => boolean;
  readonly getDirectories: (path: string) => string[];
  readonly realpath: (path: string) => string;
}

/** The contained view (see `InTreeView`) over the default host `base`. */
function containedAnswers(workspaceRoot: string, base: ts.CompilerHost): ViewAnswers {
  const workspace = containedWorkspace(workspaceRoot);
  const root = workspace.root;
  const baseReadFile = base.readFile.bind(base);
  const baseFileExists = base.fileExists.bind(base);
  const baseDirectoryExists = base.directoryExists?.bind(base);
  const baseRealpath = base.realpath?.bind(base);
  const insideWorkspace = (fileName: string): string | null => {
    const relativePath = normalizeWorkspacePath(relative(root, resolve(root, fileName)));
    return relativePath === '' || relativePath.startsWith('../') ? null : relativePath;
  };
  return {
    readFile: (fileName) => {
      const relativePath = insideWorkspace(fileName);
      if (relativePath === null) return baseReadFile(fileName);
      try {
        return workspace.readFile(relativePath);
      } catch {
        // A path containment refuses is an unreadable module, exactly as a
        // missing one: the program reports it unresolved, never read.
        return undefined;
      }
    },
    fileExists: (fileName) => {
      const relativePath = insideWorkspace(fileName);
      return relativePath === null
        ? baseFileExists(fileName)
        : workspace.entry(relativePath) === 'file';
    },
    directoryExists: (fileName) => {
      const relativePath = insideWorkspace(fileName);
      if (relativePath === null) return baseDirectoryExists?.(fileName) ?? false;
      return workspace.entry(relativePath) === 'directory';
    },
    // The default host's listing: what is listed is then asked of fileExists/directoryExists.
    getDirectories: (fileName) => ts.sys.getDirectories(fileName),
    // A workspace path is its own resolution: no symlink inside it is crossed.
    realpath: (fileName) => {
      const relativePath = insideWorkspace(fileName);
      return relativePath === null ? (baseRealpath?.(fileName) ?? fileName) : fileName;
    },
  };
}

/** Where a path the checker asks about lies in the tracked view. */
type TrackedScope =
  | { readonly kind: 'tree'; readonly path: string }
  | { readonly kind: 'installed' }
  | { readonly kind: 'outside' };

/** The tracked view (see `InTreeView`) over the default host `base`. */
function trackedAnswers(tree: TrackedContent, base: ts.CompilerHost): ViewAnswers {
  const baseReadFile = base.readFile.bind(base);
  const baseRealpath = base.realpath?.bind(base);
  const installedRoots = [join(tree.root, 'node_modules'), dirname(ts.getDefaultLibFilePath({}))]
    .filter((path) => ts.sys.directoryExists(path))
    .flatMap((path) => [...new Set([path, ts.sys.realpath?.(path) ?? path])]);
  const scopeOf = (path: string): TrackedScope => {
    const absolute = resolve(tree.root, path);
    const inTree = relative(tree.root, absolute);
    if (inTree !== '..' && !inTree.startsWith(`..${sep}`) && !isAbsolute(inTree)) {
      const posix = normalizeWorkspacePath(inTree);
      if (posix === 'node_modules' || posix.startsWith('node_modules/')) {
        return { kind: 'installed' };
      }
      return { kind: 'tree', path: posix };
    }
    const installed = installedRoots.some(
      (root) => absolute === root || absolute.startsWith(`${root}${sep}`),
    );
    return installed ? { kind: 'installed' } : { kind: 'outside' };
  };
  const fileExists = (path: string): boolean => {
    const scope = scopeOf(path);
    if (scope.kind === 'tree') return tree.holdsFile(scope.path);
    return scope.kind === 'installed' && ts.sys.fileExists(path);
  };
  const directoryExists = (path: string): boolean => {
    const scope = scopeOf(path);
    if (scope.kind === 'tree') return tree.holdsDirectory(scope.path);
    return scope.kind === 'installed' && ts.sys.directoryExists(path);
  };
  return {
    readFile: (path) => (fileExists(path) ? baseReadFile(path) : undefined),
    fileExists,
    directoryExists,
    getDirectories: (path) =>
      directoryExists(path)
        ? ts.sys.getDirectories(path).filter((name) => directoryExists(join(path, name)))
        : [],
    // A tracked path holds no symlink, so it is its own real path; the toolchain's links resolve.
    realpath: (path) =>
      scopeOf(path).kind === 'installed' ? (baseRealpath?.(path) ?? path) : path,
  };
}

/**
 * The one ts.CompilerHost builder (ARIA-LOW-593): a host whose every
 * filesystem answer comes from `view` (see `InTreeView`), so a program built
 * on it reads exactly what the view shows and never follows a symlink inside
 * the tree the way the default host (ts.sys) does. The answers are installed
 * on the host object AFTER `createCompilerHost`, which is what makes them
 * bind: TS 5.9's `getSourceFile` reads through `compilerHost.readFile` (a
 * property lookup at call time), and module resolution asks
 * `fileExists`/`directoryExists`/`realpath` the same way.
 */
export function containedCompilerHost(
  view: InTreeView,
  options: ts.CompilerOptions,
): ts.CompilerHost {
  const host = ts.createCompilerHost(options);
  const answers =
    view.kind === 'contained'
      ? containedAnswers(view.workspaceRoot, host)
      : trackedAnswers(view.tree, host);
  host.readFile = answers.readFile;
  host.fileExists = answers.fileExists;
  host.directoryExists = answers.directoryExists;
  host.getDirectories = answers.getDirectories;
  host.realpath = answers.realpath;
  return host;
}

/**
 * The one way an adapter builds a ts.Program: on `containedCompilerHost` with
 * the adapter's view, so every module the program reads — the walked files
 * and whatever they import — is read through that view, and nothing behind a
 * workspace symlink is ever resolved (ARIA-LOW-593). The shared compiler
 * options (one copy, this owner) are the adapters' analysis settings;
 * `extraOptions` adds what a specific adapter's language surface needs
 * (tenant-scoping's decorators), and cannot weaken the view.
 */
export function createContainedProgram(
  view: InTreeView,
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
  return ts.createProgram([...files], options, containedCompilerHost(view, options));
}
