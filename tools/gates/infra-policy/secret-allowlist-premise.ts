/**
 * Secrets hidden by the gitleaks path allowlist — the premise check (ARIA-HIGH-012).
 *
 * WHY this and not a secret regex of our own: `.gitleaks.toml` is the one owner of "what a
 * committed secret looks like"; gitleaks enforces it in CI on every PR. Its env-secret rule
 * path-allowlists every compose, Helm and Kubernetes YAML on a premise it cannot check:
 * "compose/Helm/env templates reference secrets, never contain them literally". This module
 * loads that rule from `.gitleaks.toml` itself and reports each structured env entry in an
 * allowlisted file that the rule WOULD report — exactly what the allowlist hides.
 *
 * RE2 -> JavaScript: gitleaks runs Go's RE2. The translation does two faithful things only:
 * a leading `(?i)` becomes the `i` flag, and an RE2 escaped punctuation character that is not
 * a JS syntax character (`\"`, `\'`, `\-` outside a class ...) becomes the literal. The result
 * compiles with the `u` flag, so any other RE2-only construct (`\z`, `(?P<n>`, `[[:alpha:]]`,
 * a mid-pattern flag group) is a SyntaxError, raised loudly, never a silent mismatch.
 */
import { parse as parseToml } from 'smol-toml';

export const ENV_SECRET_RULE_ID = 'aquaculture-env-secret-assignment';

/** Characters JS accepts escaped under the `u` flag (outside / inside a class). */
const JS_SYNTAX = new Set([
  '^',
  '$',
  '\\',
  '.',
  '*',
  '+',
  '?',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '|',
  '/',
]);
const ASCII_PUNCT = /[!-/:-@[-`{-~]/;

export function translateRe2(pattern: string): RegExp {
  let source = pattern;
  let flags = 'u';
  if (source.startsWith('(?i)')) {
    source = source.slice(4);
    flags += 'i';
  }
  let out = '';
  let inClass = false;
  for (let i = 0; i < source.length; i += 1) {
    const c = source.charAt(i);
    if (c === '\\' && i + 1 < source.length) {
      const next = source.charAt(i + 1);
      const keep = JS_SYNTAX.has(next) || (inClass && next === '-') || !ASCII_PUNCT.test(next);
      out += keep ? `\\${next}` : next;
      i += 1;
      continue;
    }
    if (c === '[' && !inClass) inClass = true;
    else if (c === ']' && inClass) inClass = false;
    out += c;
  }
  try {
    return new RegExp(out, flags);
  } catch (error) {
    throw new Error(
      `gitleaks regex cannot be translated to JavaScript: ${pattern}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface GitleaksPatternSource {
  /** Where the pattern sits, e.g. `rules[aquaculture-env-secret-assignment].regex`. */
  readonly location: string;
  readonly source: string;
}

type TomlTable = Readonly<Record<string, unknown>>;

function table(value: unknown): TomlTable | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as TomlTable)
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** A rule's or the global allowlists, in either gitleaks spelling (`allowlist` / `allowlists`). */
function allowlistsOf(owner: TomlTable): TomlTable[] {
  const single = table(owner.allowlist);
  const many = Array.isArray(owner.allowlists)
    ? owner.allowlists.map(table).filter((t): t is TomlTable => t !== null)
    : [];
  return single === null ? many : [single, ...many];
}

function rulesOf(config: TomlTable): TomlTable[] {
  return Array.isArray(config.rules)
    ? config.rules.map(table).filter((t): t is TomlTable => t !== null)
    : [];
}

/** Every regex string in the file: rule regexes and every allowlist regex and path. */
export function gitleaksPatterns(tomlText: string): GitleaksPatternSource[] {
  const config = parseToml(tomlText) as TomlTable;
  const out: GitleaksPatternSource[] = [];
  const fromAllowlists = (owner: TomlTable, where: string): void => {
    allowlistsOf(owner).forEach((list, index) => {
      for (const field of ['regexes', 'paths'] as const) {
        strings(list[field]).forEach((source, i) =>
          out.push({ location: `${where}.allowlist[${index}].${field}[${i}]`, source }),
        );
      }
    });
  };
  for (const rule of rulesOf(config)) {
    const id = typeof rule.id === 'string' ? rule.id : '?';
    for (const field of ['regex', 'path'] as const) {
      if (typeof rule[field] === 'string')
        out.push({ location: `rules[${id}].${field}`, source: rule[field] });
    }
    fromAllowlists(rule, `rules[${id}]`);
  }
  fromAllowlists(config, 'global');
  return out;
}

export interface CompiledPattern {
  readonly source: string;
  readonly regex: RegExp;
}

export interface AllowlistSet {
  readonly paths: readonly CompiledPattern[];
  readonly regexes: readonly CompiledPattern[];
  readonly stopwords: readonly string[];
  /** What `regexes` are matched against: the secret (gitleaks default), the match or the line. */
  readonly regexTarget: 'secret' | 'match' | 'line';
}

export interface EnvSecretRule {
  readonly id: string;
  readonly regex: RegExp;
  /** The rule's `secretGroup`; null when it sets none and gitleaks' default applies (secretOf). */
  readonly secretGroup: number | null;
  readonly keywords: readonly string[];
  readonly entropy: number | null;
  readonly ruleAllowlists: readonly AllowlistSet[];
  readonly globalAllowlists: readonly AllowlistSet[];
}

function compile(sources: readonly string[]): CompiledPattern[] {
  return sources.map((source) => ({ source, regex: translateRe2(source) }));
}

function allowlistSet(list: TomlTable, where: string): AllowlistSet {
  const condition = list.condition;
  if (
    condition !== undefined &&
    (typeof condition !== 'string' || condition.toUpperCase() !== 'OR')
  ) {
    // AND-combined allowlists change what is suppressed; reading them as OR would hide less
    // than gitleaks does and report secrets gitleaks never would.
    throw new Error(`${where}: allowlist condition ${JSON.stringify(condition)} is not supported`);
  }
  const rawTarget = list.regexTarget;
  const target =
    rawTarget === undefined
      ? 'secret'
      : typeof rawTarget === 'string'
        ? rawTarget
        : JSON.stringify(rawTarget);
  if (target !== 'secret' && target !== 'match' && target !== 'line') {
    throw new Error(`${where}: unknown regexTarget ${target}`);
  }
  return {
    paths: compile(strings(list.paths)),
    regexes: compile(strings(list.regexes)),
    stopwords: strings(list.stopwords).map((w) => w.toLowerCase()),
    regexTarget: target,
  };
}

/** Load the env-secret rule and the allowlists that apply to it from `.gitleaks.toml` text. */
export function loadEnvSecretRule(tomlText: string): EnvSecretRule {
  const config = parseToml(tomlText) as TomlTable;
  const rule = rulesOf(config).find((r) => r.id === ENV_SECRET_RULE_ID);
  if (rule === undefined || typeof rule.regex !== 'string') {
    throw new Error(`.gitleaks.toml has no rule ${ENV_SECRET_RULE_ID} with a regex`);
  }
  return {
    id: ENV_SECRET_RULE_ID,
    regex: translateRe2(rule.regex),
    secretGroup: typeof rule.secretGroup === 'number' ? rule.secretGroup : null,
    keywords: strings(rule.keywords).map((k) => k.toLowerCase()),
    entropy: typeof rule.entropy === 'number' ? rule.entropy : null,
    ruleAllowlists: allowlistsOf(rule).map((l, i) =>
      allowlistSet(l, `rules[${ENV_SECRET_RULE_ID}].allowlist[${i}]`),
    ),
    globalAllowlists: allowlistsOf(config).map((l, i) => allowlistSet(l, `global.allowlist[${i}]`)),
  };
}

export interface StructuredEnvEntry {
  /** Repo-relative file path. */
  readonly path: string;
  readonly line: number;
  readonly key: string;
  readonly value: string;
}

/**
 * Where a hidden secret sits, never what it is. A hit becomes ARIA findings, evidence and PR
 * text, so it carries no field that holds the value (not the entry's value, not a hash: a hash
 * of a low-entropy secret confirms a guess). Path, line and key locate it; the length tells a
 * reader it is a real literal without repeating it.
 */
export interface HiddenSecret {
  readonly path: string;
  readonly line: number;
  readonly key: string;
  readonly secretLength: number;
  /** The allowlist path pattern that hides it from gitleaks. */
  readonly hiddenBy: string;
}

function shannonEntropy(text: string): number {
  const counts = new Map<string, number>();
  for (const c of text) counts.set(c, (counts.get(c) ?? 0) + 1);
  let entropy = 0;
  for (const n of counts.values()) {
    const p = n / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * The secret of a match, as gitleaks v8 reads it (detect.go): the `secretGroup` capture when the
 * rule sets one; otherwise the first non-empty capture group, or the whole match when the regex
 * has no group or every group is empty. Reading group 0 by default tested value-shaped allowlists
 * against `KEY=value`, so they never suppressed, and reported the match length as the secret's
 * (ARIA-HIGH-012 landing fix 7).
 */
function secretOf(match: RegExpExecArray, secretGroup: number | null): string | undefined {
  if (secretGroup !== null) return match[secretGroup];
  const firstGroup = match.slice(1).find((group) => group !== undefined && group.length > 0);
  return firstGroup === undefined ? match[0] : firstGroup;
}

function suppressedByValue(
  lists: readonly AllowlistSet[],
  secret: string,
  match: string,
  line: string,
): boolean {
  return lists.some((list) => {
    const target =
      list.regexTarget === 'secret' ? secret : list.regexTarget === 'match' ? match : line;
    if (list.regexes.some((p) => p.regex.test(target))) return true;
    const lower = secret.toLowerCase();
    return list.stopwords.some((w) => lower.includes(w));
  });
}

function hidingPath(lists: readonly AllowlistSet[], path: string): string | null {
  for (const list of lists) {
    const hit = list.paths.find((p) => p.regex.test(path));
    if (hit !== undefined) return hit.source;
  }
  return null;
}

/**
 * Entries the rule would report but a path allowlist hides. An entry outside every path
 * allowlist is not returned: gitleaks reports it itself, nothing is hidden.
 */
export function secretsHiddenByPathAllowlist(
  entries: readonly StructuredEnvEntry[],
  rule: EnvSecretRule,
): HiddenSecret[] {
  const out: HiddenSecret[] = [];
  for (const entry of entries) {
    const line = `${entry.key}=${entry.value}`;
    if (rule.keywords.length > 0 && !rule.keywords.some((k) => line.toLowerCase().includes(k)))
      continue;
    const match = rule.regex.exec(line);
    if (match === null) continue;
    const secret = secretOf(match, rule.secretGroup);
    if (secret === undefined || secret.length === 0) continue;
    if (rule.entropy !== null && shannonEntropy(secret) < rule.entropy) continue;
    const allLists = [...rule.ruleAllowlists, ...rule.globalAllowlists];
    if (suppressedByValue(allLists, secret, match[0], line)) continue;
    const hiddenBy = hidingPath(allLists, entry.path);
    if (hiddenBy !== null)
      out.push({
        path: entry.path,
        line: entry.line,
        key: entry.key,
        secretLength: secret.length,
        hiddenBy,
      });
  }
  return out;
}
