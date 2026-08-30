import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { listActiveAgentFiles, REPO_ROOT } from './lib/agent-files';

function read(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

const activeAgents = listActiveAgentFiles();

describe('agent prompt contract invariants', () => {
  it('discovers the active prompt corpus recursively', () => {
    expect(activeAgents.length).toBeGreaterThan(60);
    expect(activeAgents.map((file) => file.relPath)).toContain(
      '.claude/agents/edge-docs/edge-docs-orchestrator.md',
    );
    expect(activeAgents.map((file) => file.relPath)).toContain(
      '.claude/agents/_maintenance/aria-prompt-writer.md',
    );
  });

  it('retired prompt folders stay absent from active prompt discovery and disk', () => {
    const discovered = activeAgents.map((file) => file.relPath);
    expect(
      discovered.filter(
        (path) =>
          path.startsWith('.claude/test-agents/') ||
          path.startsWith('.claude/agents-enterprise-v2/') ||
          path.startsWith('.claude/agents.legacy/'),
      ),
    ).toEqual([]);

    for (const relPath of [
      '.claude/test-agents',
      '.claude/agents-enterprise-v2',
      '.claude/agents.legacy',
    ]) {
      expect(existsSync(join(REPO_ROOT, relPath))).toBe(false);
    }
  });

  it('ARIA prompts carry the canonical ARIA reference set', () => {
    // E17-a: the four runtime-dispatched judge/worker agents read the
    // generated contract digest instead of cold-reading SPEC + CONTRACTS +
    // PIPELINES + layer-1-aria (125,735 bytes of @-refs, replaced by an 8.5KB
    // digest). They keep the layer-2 envelope ref because the verdict schema,
    // satisfaction entries, and envelope trust rules live there. Their digest
    // contract is pinned below and byte-for-byte in
    // aria-kernel/tests/test_judge_digest_ssot.py.
    const judgeDigestAgents = new Set<string>([
      '.claude/agents/aria-evidence-judge.md',
      '.claude/agents/aria-adversarial-judge.md',
      '.claude/agents/aria-cross-reviewer.md',
      '.claude/agents/aria-worker.md',
    ]);
    const ariaAgents = activeAgents.filter(
      (file) =>
        file.filenameStem.startsWith('aria-') ||
        file.relPath.includes('/_maintenance/aria-'),
    );

    for (const file of ariaAgents) {
      if (judgeDigestAgents.has(file.relPath)) {
        expect(file.content).toContain('@docs/aria/generated/JUDGE-DIGEST.md');
        expect(file.content).toContain('@.claude/knowledge/layer-2-aria-canonical-envelope.md');
        expect(file.content).toContain(
          'Read the FULL SPEC/CONTRACTS only when a digest pointer proves insufficient — cite the anchor you followed.',
        );
        // The digest REPLACES the full-doc preamble; a direct @-ref sneaking
        // back in silently restores the 138KB cold-read cost.
        expect(file.content).not.toContain('@docs/aria/SPEC.md');
        expect(file.content).not.toContain('@docs/aria/CONTRACTS.md');
        expect(file.content).not.toContain('@docs/aria/PIPELINES.md');
        continue;
      }
      expect(file.content).toContain('@.claude/knowledge/layer-1-aria.md');
      expect(file.content).toContain('@.claude/knowledge/layer-2-aria-canonical-envelope.md');
      expect(file.content).toContain('@docs/aria/SPEC.md');
      expect(file.content).toContain('@docs/aria/CONTRACTS.md');
    }
  });

  it('architectural-arbiter uses normalized ADR path and scoped ADR persistence', () => {
    const body = read('.claude/agents/architectural-arbiter.md');
    expect(body).toContain(
      'docs/recommendations/architectural-arbiter/{YYYY-MM-DD}-adr-{NNNN}-{topic}.md',
    );
    expect(body).toContain(
      'Every CRITICAL, HIGH, cross-context, ownership, event-contract, schema, strategic, prior-ADR-superseding, or agent-recommendation-superseding arbitration MUST be persisted as an ADR',
    );
    expect(body).not.toContain('Every arbitration decision is persisted as an ADR');
    expect(body).toContain('ARCH-{SEVERITY}-{NNN}');
  });

  it('prompt-writing rules require rationale and consequence, not bare commands', () => {
    const template = read('.claude/shared/_conversion-template.md');
    const promptWriter = read('.claude/agents/_maintenance/prompt-writer.md');

    expect(template).toContain('Rule / Why this exists / Protected invariant / Consequence if ignored');
    expect(template).toContain("No bare do/don't bullets");
    expect(promptWriter).toContain('why the rule exists, the invariant it protects, and the breakage caused by violation');
    expect(promptWriter).toContain('Explain consequence, not only prohibition');
  });

  it('cross-agent supersession requires coordination', () => {
    const handoff = read('.claude/shared/handoff-protocol.md');
    const modes = read('.claude/shared/operating-modes.md');
    const arbiter = read('.claude/agents/architectural-arbiter.md');

    expect(handoff).toContain('Supersession / destructive overlap');
    expect(handoff).toContain('MUST NOT silently overwrite');
    expect(modes).toContain("WRITER must not silently overwrite another agent's open work");
    expect(arbiter).toContain('coordinate supersession');
  });

  it('cross-cutting finding prefixes are unambiguous', () => {
    const securityReviewer = read('.claude/agents/security-reviewer.md');
    const testRunner = read('.claude/agents/test-runner.md');
    const outputFormat = read('.claude/shared/output-format.md');

    expect(securityReviewer).toContain('GSEC-{SEVERITY}-{NNN}');
    expect(testRunner).toContain('TEST-{SEVERITY}-{NNN}');
    expect(outputFormat).toContain('GSEC-*');
    expect(outputFormat).toContain('TEST-*');
    expect(outputFormat).toContain('ARCH-*');
    expect(outputFormat).toContain('PRODUCT-{AGENT-PREFIX}-*');
  });

  it('shared output prefixes map retired platform lanes to active owners', () => {
    const outputFormat = read('.claude/shared/output-format.md');

    expect(outputFormat).toContain('`PLAT-*` — platform-kernel-expert only');
    expect(outputFormat).toContain('`BILLING-*` — billing-expert');
    expect(outputFormat).toContain('`ALERT-*` — alert-engine-expert');
    expect(outputFormat).toContain('`OBS-*` — observability-expert');
    expect(outputFormat).toContain('`MSG-*` — messaging-expert');
    expect(outputFormat).not.toContain('platform-services');
    expect(outputFormat).not.toContain('billing/notification/config/event-store/observability');
    expect(outputFormat).not.toContain('`FARM-*`, `SENSOR-*`, `HR-*`, `MSG-*`, `ADMIN-*`');
  });

  it('Lane-B product-audit prompts use product-audit recommendation paths and PRODUCT sub-prefixes', () => {
    const laneB = activeAgents.filter((file) =>
      file.relPath.startsWith('.claude/agents/product-audit/'),
    );
    const legacyPath = laneB
      .filter((file) => file.content.includes('docs/recommendations/test-audits'))
      .map((file) => file.relPath);
    expect(legacyPath).toEqual([]);

    const missingProductPrefix = laneB
      .filter((file) => file.content.includes('Report finding ID format'))
      .filter((file) => !/PRODUCT-[A-Z0-9]+-\{SEVERITY\}-\{NNN\}/.test(file.content))
      .map((file) => file.relPath);
    expect(missingProductPrefix).toEqual([]);
  });

  it('test-runner does not claim unavailable web tools or primary build ownership', () => {
    const body = read('.claude/agents/test-runner.md');
    expect(body).not.toMatch(/WebSearch|WebFetch/);
    expect(body).toContain('Build and type-check execution is owned by `build-validator`');
    expect(body).not.toContain('Run `npm run build` or `npx nx run-many --target=build --all`');
  });

  it('ARIA implementer branches before edits, scans secrets, gates before the PR', () => {
    const body = read('.claude/agents/aria-implementer.md');
    // ORPHAN-CRITICAL-727 — the agent no longer MINTS the branch. The name is
    // minted kernel-side by stage_converged_plan_for_pr (single naming
    // authority) and delivered on the envelope as implementation_ids.branch;
    // an agent that minted its own produced a branch the push allowlist and
    // the PR manager had never heard of. The ordering claim is unchanged:
    // branch first, edits second.
    expect(body).toMatch(
      /Switch to the kernel-minted implementation branch[\s\S]*Apply key_changes/,
    );
    expect(body).toContain('implementation_ids');
    expect(body).toMatch(/Stage and secret-scan before commit[\s\S]*Commit/);
    // ORPHAN-CRITICAL-727 — the apply gate sits BETWEEN the committed-patch
    // scan and the PR. open_pr_for_action refuses an action that is not
    // ready_for_pr with a validation_gate_ref, and `apply gate` is the only
    // producer of both; an agent that jumps straight to `pr create` earns a
    // refusal it cannot diagnose.
    expect(body).toMatch(
      /Secret-scan committed patch[\s\S]*Pass the apply gate[\s\S]*Open PR/,
    );
    expect(body).toContain('python3 -m aria_kernel apply gate');
    expect(body).not.toContain('17 refusal classes');
    // ORPHAN-CRITICAL-728 — the branch is cut from the staged base_sha, not
    // from origin/<base>. Staging measured its baseline validation at that
    // commit and the gate diffs base_sha..branch; branching from a moved
    // origin/main puts third-party commits inside the diff the suppression
    // and secret scans judge, and makes the baseline↔candidate comparison
    // compare two different bases.
    expect(body).toContain('<implementation_ids.base_sha>');
    expect(body).not.toMatch(/git switch -c <implementation_ids\.branch> origin\//);
    // And the gate must run standing on that branch: validation executes at
    // HEAD, so evidence recorded against any other commit is fabricated.
    expect(body).toContain('apply_gate_head_is_not_the_branch');
  });
});
