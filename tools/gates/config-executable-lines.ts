/**
 * The executable-line classifier for configuration text: which lines of a YAML, Dockerfile or
 * conf file perform behaviour, and which only describe it.
 *
 * WHY this module exists: a policy scan that matches the words of a rule reports commented-out
 * lookalikes as if they were live (ORPHAN-MEDIUM-458's lesson).
 * tests/invariants/helm-dependency-single-path.spec.ts tripped over it twice on its first run: both
 * callsites' comments and the step's own `name:` label quoted the command they described, so a raw
 * text scan reported three implementations where there was one. That spec and
 * tests/invariants/deploy-ssot-contract.spec.ts each kept their own comment stripper; both import
 * it here now (ARIA-HIGH-012 landing).
 *
 * Line-level rather than a YAML parse, because an inline `#` following a real command is part of
 * an executable line, and because `name:` is unambiguous at line level in a workflow file.
 */

/** The lines of a document with comment-only lines removed (trailing whitespace trimmed). */
export function uncommentedLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => !line.trimStart().startsWith('#'));
}

/**
 * The file with the lines that DESCRIBE behaviour, rather than perform it, removed: comments and
 * step labels (`name:`). Matching the description instead of the thing is how a policy scan turns
 * accurate documentation into a finding, and a gate that fails on accurate documentation gets the
 * documentation deleted, or the step renamed to something less true.
 */
export function executableYaml(body: string): string {
  return uncommentedLines(body)
    .filter((line) => !/^-?\s*name:/.test(line.trimStart()))
    .join('\n');
}
