const TOOLCHAIN_ESLINT_RUNTIME_ENV = Object.freeze({
  NX_PREFER_NODE_STRIP_TYPES: 'true',
});

const TOOLCHAIN_NX_RUNTIME_ENV = Object.freeze({
  NX_ISOLATE_PLUGINS: 'false',
});

const TOOLCHAIN_NODE_HEAP_FLOOR_MB = 4096;
const NODE_HEAP_OPTION_PREFIX = '--max-old-space-size=';

const FORBIDDEN_WARNING_SUPPRESSION_TOKENS = Object.freeze([
  'NODE_NO_WARNINGS',
  '--no-deprecation',
  '--disable-warning=DeprecationWarning',
]);

function parseNodeHeapMb(entry) {
  if (!entry.startsWith(NODE_HEAP_OPTION_PREFIX)) {
    return null;
  }

  const parsed = Number.parseInt(entry.slice(NODE_HEAP_OPTION_PREFIX.length), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeNodeOptions(value) {
  const withoutHeapLimit = [];
  let heapFloorMb = TOOLCHAIN_NODE_HEAP_FLOOR_MB;

  for (const entry of value.split(/\s+/).filter((item) => item.length > 0)) {
    const parsedHeapMb = parseNodeHeapMb(entry);
    if (parsedHeapMb === null) {
      withoutHeapLimit.push(entry);
      continue;
    }
    heapFloorMb = Math.max(heapFloorMb, parsedHeapMb);
  }

  return [...withoutHeapLimit, `${NODE_HEAP_OPTION_PREFIX}${heapFloorMb}`].join(' ');
}

function applyRuntimeEnvValues(values, env) {
  for (const [key, value] of Object.entries(values)) {
    env[key] = value;
  }
}

function applySharedRuntimeEnv(env) {
  env.NODE_OPTIONS = normalizeNodeOptions(env.NODE_OPTIONS ?? '');

  if (env.NO_COLOR !== undefined) {
    delete env.NO_COLOR;
  }
}

export function applyEslintRuntimeEnv(env = process.env) {
  applyRuntimeEnvValues(TOOLCHAIN_ESLINT_RUNTIME_ENV, env);
  applySharedRuntimeEnv(env);
}

export function applyNxRuntimeEnv(env = process.env) {
  applyRuntimeEnvValues(TOOLCHAIN_NX_RUNTIME_ENV, env);
  delete env.NX_PREFER_NODE_STRIP_TYPES;
  applySharedRuntimeEnv(env);
}

export function applyToolchainRuntimeEnv(env = process.env) {
  applyEslintRuntimeEnv(env);
}

export function getToolchainEslintRuntimeEnv() {
  return TOOLCHAIN_ESLINT_RUNTIME_ENV;
}

export function getToolchainNxRuntimeEnv() {
  return TOOLCHAIN_NX_RUNTIME_ENV;
}

export function getForbiddenWarningSuppressionTokens() {
  return FORBIDDEN_WARNING_SUPPRESSION_TOKENS;
}
