const TOOLCHAIN_ESLINT_RUNTIME_ENV = Object.freeze({
  NX_PREFER_NODE_STRIP_TYPES: 'true',
});

const TOOLCHAIN_NX_RUNTIME_ENV = Object.freeze({
  NX_ISOLATE_PLUGINS: 'false',
});

const TOOLCHAIN_NODE_OPTIONS = Object.freeze(['--max-old-space-size=4096']);

const FORBIDDEN_WARNING_SUPPRESSION_TOKENS = Object.freeze([
  'NODE_NO_WARNINGS',
  '--no-deprecation',
  '--disable-warning=DeprecationWarning',
]);

function normalizeNodeOptions(value) {
  const withoutHeapLimit = value
    .split(/\s+/)
    .filter((entry) => entry.length > 0)
    .filter((entry) => !entry.startsWith('--max-old-space-size='));
  return [...withoutHeapLimit, ...TOOLCHAIN_NODE_OPTIONS].join(' ');
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
