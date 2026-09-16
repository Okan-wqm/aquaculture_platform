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

  it('ARIA implementer stands on the kernel-made branch, scans secrets, stops at the commit', () => {
    const body = read('.claude/agents/aria-implementer.md');
    // ORPHAN-CRITICAL-727 — the agent never MINTS the branch: the name is
    // minted kernel-side by stage_converged_plan_for_pr and delivered on the
    // envelope as implementation_ids.branch. ARIA-HIGH-124 — nor does it
    // SWITCH to it: the executor stands the sandbox on the branch before the
    // first command (the command policy never admitted `git switch`), and
    // the agent confirms where it stands before editing.
    expect(body).toMatch(
      /Confirm you stand on the kernel-made branch before edits[\s\S]*Apply key_changes/,
    );
    expect(body).toContain('implementation_ids');
    expect(body).not.toMatch(/git switch -c/);
    // ARIA-HIGH-124 (round 6) — the agent READS its diff; the scan is the
    // executor's (`verify_no_secret_in_diff` over the branch's whole patch,
    // before the suite): a prompt that told the agent to CALL the scanner
    // named a Python function it cannot execute, and nothing ran it.
    expect(body).toMatch(/Stage and read the diff for secrets[\s\S]*Commit/);
    expect(body).not.toMatch(/verify_no_secret_in_diff\(/);
    expect(body).toContain('implementation_delivery_refused:result_admissible');
    // ARIA-HIGH-124 — the agent's steps END at the commit. The push, the
    // apply gate and the PR are the executor's, outside the sandbox: an
    // agent told to run `apply gate` / `pr create` / `git push` inside was
    // told to run commands the policy refuses against a store that is not
    // mounted there. The prompt names them only as refused.
    expect(body).toMatch(
      /Stage and read the diff for secrets[\s\S]*Stop at the commit[\s\S]*Submit response envelope/,
    );
    expect(body).not.toMatch(/\d+b?\. \*\*Pass the apply gate\*\*/);
    expect(body).not.toMatch(/\d+\. \*\*Open PR\*\*/);
    expect(body).toContain('implementation_delivery');
    expect(body).toContain('kernel_authority');
    expect(body).not.toContain('ARIA_EXECUTOR_PR_VIA_KERNEL');
    expect(body).not.toContain('17 refusal classes');
    // ORPHAN-CRITICAL-728 — the branch is cut from the staged base_sha, not
    // from origin/<base>: staging measured its baseline there and the gate
    // diffs base_sha..branch. The agent verifies HEAD is that commit.
    expect(body).toContain('<implementation_ids.base_sha>');
    expect(body).not.toMatch(/origin\/<ARIA_PR_BASE>/);
    // The kernel-stamped record: the agent supplies no delivery facts.
    expect(body).toContain('KERNEL_STAMPED_DELIVERY_FIELDS');
  });
});
