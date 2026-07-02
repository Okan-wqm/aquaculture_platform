# ARIA Agent & Skill Authoring Standards Contract

Canonical rules for every agent or skill body that ARIA authors itself —
genesis drafts synthesized by `aria-drafter` from a kernel `DraftIntent`,
prompts rendered or revised by `aria-prompt-writer`, and adapter/skill sources
from the convergent authoring loop. Operators reviewing the Plan 009
kernel-self-change lane hold drafts to this contract. CLAUDE.md and the
kernel validators win on any conflict.

## Canonical References (READ via the Read tool before starting)

- @.claude/agents/_maintenance/aria-prompt-writer.md (clause-set SSoT for ARIA prompt content)
- @.claude/agents/_shared/aria-code-writing-standards.md (rules for code embedded in bodies)
- @aria-kernel/aria_kernel/narrative_prompt_validator.py (pedagogy shape + token budgets)
- @aria-kernel/aria_kernel/draft_intent.py (DraftIntent schema + `BANNED_PHRASES_DEFAULT`)
- @docs/aria/CONTRACTS.md (§1 Adapter Protocol, §2 Skill Protocol)
- @docs/aria/PIPELINES.md (which lane consumes which artifact)

## 1. Frontmatter is a contract, not decoration

- `name:` equals the filename stem and is globally unique across
  `.claude/agents/**` (`tests/invariants/agent-name-uniqueness.spec.ts`).
- `model:` and `effort:` come from the operator model-tier policy — decision
  nodes on the top tier, judge/validator layer one tier below — resolved at
  runtime by `aria_kernel/agent_runtime_profile.py`. Never hardcode a model
  value inside a body's prose; cite the resolver. Agents holding Edit/Write/
  Bash belong in `WRITE_TIER_AGENTS` (python) + `ARIA_WRITE_TIER` (jest) in
  the same change.
- `tools:` is the minimal set the role needs; expanding a tool surface is an
  operator decision, not a drafting convenience.
- `pedagogy-tier:` matches the agent's `.claude/agents/_pedagogy-registry.json`
  entry; creating an agent file without its registry entry fails I-V4-01/02.
- `dispatch:` (`maintenance` | `ad-hoc` | `cross-cutting`) whenever the agent
  is not glob-routed by the orchestrator.

## 2. Mandatory clause set

Every ARIA agent prompt carries the full clause checklist owned by
`aria-prompt-writer` (role boundary, envelope inputs/outputs, quoted laws,
forbidden scopes, evidence rules, banned-phrase discipline, refusal protocol,
separation of duties, self-modification prohibition, pedagogy declaration,
plus the writer-class and prompt-shape clauses). That mandate is the SSoT —
consult it there; never fork a private copy of the list into a draft.

## 3. Reference discipline (anti-inlining)

Bodies cite shared knowledge with `@`-bookmarks and never inline it
(`tests/invariants/agent-inlining-ssot.spec.ts`). Every ARIA agent carries the
four canonical references (`layer-1-aria`, `layer-2-aria-canonical-envelope`,
`docs/aria/SPEC.md`, `docs/aria/CONTRACTS.md`) per
`tests/invariants/agent-prompt-contract.spec.ts`. Genesis drafts cite ONLY
refs present in the DraftIntent `evidence_allowlist` — an out-of-allowlist
citation is a refusal (`DRAFTER_REFUSAL:evidence_allowlist_empty`), not a
judgment call.

## 4. Pedagogy shape and token budgets

`narrative_prompt_validator.py` is the structural gate: every
`### Prohibition:` block in a Tier-2/3 body carries the full section set
(**Rule** + Temptation / Why-it-looks-correct / Downstream-consequence /
Correct-path ending on the invariant); Tier-1 bodies stay bare-imperative;
consequence-leak-protected rules omit the consequence section. Token budgets
are per tier (T1 1500 / T2 2800 / T3 3500) — a draft that needs more space is
a draft whose scope should be split, not a budget to negotiate.

## 5. Prompt-shape economy (Fable runtime)

State goals and hard constraints; use enumerated step lists only where
ordering is safety- or protocol-load-bearing, and say why. Contracts, laws,
and prohibitions are never softened or shortened into ambiguity. Avoid
overtrigger language ("CRITICAL: You MUST…", "If in doubt, use X") — the
runtime follows instructions literally and over-fires on it. Reviewer-class
agents get coverage-first reporting (report everything with confidence +
severity; filtering happens downstream) — never "only report high-severity".
Progress and completion claims in rendered output contracts are
evidence-grounded: verdicts trace to files actually Read in the run.

## 6. Language discipline

Zero phrases from the kernel banned-phrase SSoT
(`draft_intent.BANNED_PHRASES_DEFAULT`, mirroring CLAUDE.md §Architectural
Approach) anywhere in a drafted body, and zero hedges, apologies, or
scratch/thinking prose — `draft_validator` accepts only a clean markdown body.

## 7. Skills (SkillDraftIntent → aria-grown/skills/)

A drafted skill declares its scope explicitly and stays inside it (CONTRACTS
§2 declared-scope enforcement); aggregation follows the aggregator discipline
(observations in, one deduplicated result out — no silent drops); every
`acceptance_tests[]` entry in the intent maps to a concrete fixture defined in
the body; `target_path` stays under the lane the DraftIntent classifier
assigned. Code embedded in a skill obeys
`@.claude/agents/_shared/aria-code-writing-standards.md`.

## 8. Registration duties travel with the draft

An agent the kernel dispatches needs its `DEFAULT_TARGET_AGENT_WHITELIST` +
`ROLE_TARGET_PAIRING` entries (`aria_kernel/agent_surface.py`, Plan 009 lane);
an agent claiming Lane-A surface ownership needs its
`orchestrator-routing-table.md` row (the authoritative ownership registry);
Lane-A bodies respect the 200-line cap
(`tests/invariants/agent-size-limit.spec.ts`). A draft that creates the file
but skips its registrations ships a silent fallback — the defect class
ORPHAN-HIGH-285 documents.

## 9. Review lane

Every ARIA-authored agent/skill lands through the kernel's validation chain
(`draft_validator` for genesis, Plan 009 kernel-self-change PR lane for prompt
changes) with operator approval. Auto-merge of self-authored prompts is
forbidden in every profile.
