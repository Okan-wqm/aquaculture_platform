# ARIA and AI gaps found on 2026-10-02: retrieval, the System-1 layer, snapshot races, ack custody

Context: the operator asked whether ARIA's code is finished and where the RAG-like system and the
Jev-like decision system stand, in the repository or on any branch. `origin/main` (7166e2f5e), the
49 remote branches, the local branches and the worktrees on disk were searched by name and by
function. Two further defects came up while landing PR #1704.

Owner: claude (records), okan (decisions).

Summary of what exists:

- The Jev-like decision system is ARIA's typed judgment
  (`docs/reviews/claude/2026-09-19-aria-typed-judgment-plan.md`). Phases 1 to 6 are on `main`:
  `aria_kernel/typed_judgment.py` (`choice` / `score` / `noul`), batched judges, read-contained judge
  spawns, Brier and ECE calibration. Phase 7 (the `jev` provider and the question bank) is not.
- ARIA is not a vector RAG by design. It has an FTS5/bm25 index over its ledgers
  (`aria_kernel/search.py`), a decision-memory context pack per dispatch
  (`aria_kernel/context_compiler.py`) and a repository map (`aria_kernel/twin.py`). The embedding
  seam (`aria_kernel/semantic_memory.py`) has no model configured anywhere.
- The product's advanced RAG (bge-m3, hybrid retrieval, rerank, GraphRAG) has not started; the farm
  read tools of its first phase are live.

## MSG-MEDIUM-081

`SearchSimilarMessagesHandler` embeds the query by sending `request.ai.generateEmbeddings` over NATS
and then runs a pgvector cosine search on `messages.embedding`. Nothing on `main` answers that
subject, so the request times out after 30 seconds. The cron that filled the column was removed as
dead code in 07188601d (2026-09-17), and the owner decided during the AI and messaging revival that
message history is not a raw retrieval corpus.

Rule: A query path that ships has a responder for every request it sends, and the retrieval corpus
is the one the owner chose.

## ARIA-LOW-252

Typed-judgment Phase 7 is designed and not built: `tools/aria-poc/jev_runtime.py` and
`aria_kernel/system_one_questions.py` exist on no branch, and the word `jev` appears only in the
plan. ARIA's semantic memory resolves its embedder from `ARIA_EMBEDDER_CMD`, which no workflow,
runner file or provisioning script sets (model supply is ORPHAN-MEDIUM-639). Carrying the typed
judgment core into the product's decision layer, as System 1 under the farm specialists, was
discussed on 2026-09-19 and never planned. The feature freeze of 2026-09-28 applies until the ARIA
chain closes.

Rule: A planned capability is either built or tracked with an owner and a decision date.

## ARIA-MEDIUM-253

The state snapshot compares each surface between its two passes by
`(st_dev, st_ino, st_mode, st_mtime_ns, st_ctime_ns)` (`state_snapshot.py:1112`). A rewrite of the
same size inside one filesystem timestamp tick leaves all five equal, so the snapshot can attest
bytes that changed while it was built. `test_root_inode_stability_does_not_hide_child_content_mutation`
exercises exactly that and fails intermittently: aria-kernel run 36558928120 on `main` (2026-09-29)
and run 36990103969 on PR #1704 (2026-10-02); it passes locally.

Rule: A snapshot never attests bytes that changed while it was being built; equal timestamps do not
prove equal content.

## ARIA-MEDIUM-254

The ack ledger signs with `secrets/ack_hmac.key` under the tools root (`ack_ledger.py:61`). Inside
the aria/state store that path is never published, and the self-hosted lanes run
`git reset --hard; git clean -ffdx` before `state checkout` (`aria-auto-cycle.yml:197-205`,
`aria-agent-executor.yml:176-184`), so the key does not survive a job. An auto-ack minted and
consumed in one job is unaffected; an operator-minted token cannot verify in any later runner job.
This is the custody class of the operator-feedback key (ARIA-CRITICAL-255, named ARCH-CRITICAL-201
in the arbiter ruling).

Rule: Signing material that a later job must verify against lives where that job can read it, and
no runner-readable location holds operator signing authority.

## ARIA-LOW-318

Recorded 2026-10-03, the core half of ARIA-LOW-252 under the rev3.1 design (Jev as System One, a
reflex layer below the judges rather than a judge provider). Nothing in the kernel can reach the
vendor: there is no bounded transport whose failures are returned instead of raised, no
operator-owned registry of the measured questions (J0, R5, J2, R4, J1 tenant-scoping), and no
ledger that records a call without its input. Until all three exist, no decision point can ask a
registered question even in shadow.

Rule: A model the protocol may ask is reached through one bounded transport whose failures are
returned, asks only operator-owned questions, and records every call without its input.

Security review of #1756, 2026-10-09. The operator rule is: only public repository code and
finding or PR text may leave the host, never tenant data, logs, secrets or operator content, and
calls are logged without content. The review found and #1756 fixed:

- **Egress is built from references, not filtered from caller text.** `system_one` builds every
  state value itself from a `StateRef`:
  - a 40-hex commit the bound repository holds, read with `git`;
  - a path held to the agent evidence law, with credential-shaped files refused;
  - a finding id read from the registry.
- **The deny scan is now a backstop over the final payload.** It covers every string, mapping
  keys included, plus the wire size. It adds JWT, Stripe live/test, webhook secrets, URL
  credentials, quoted and YAML passwords, AWS, DigitalOcean, SendGrid, npm, GitLab, Google and
  Slack shapes. It also refuses e-mail addresses and IPv4 addresses outside the
  documentation/loopback ranges.
- **The transport is private to `system_one`.** An invariant test pins that only `system_one`
  imports it.
  - The endpoint is pinned (https, `api.typesafe.ai`).
  - No redirect is followed and any 3xx is refused; environment proxies are ignored.
  - One monotonic deadline covers both attempts, and the response is capped.
  - The key file is opened with `O_NOFOLLOW` and checked by `fstat` (regular file, owned by the
    euid, mode `0600`). The key must match a fixed charset.
  - Every failure names at most an exception class.
- **The ledger stores an id-shaped subject and the validated answer fields only.**
- **`system_one.py`, `jev_runtime.py` and `secret_scrub.py` are authority surfaces.**

Re-review, the same day:

- **"Public" now means what the remote `origin` publishes.** A commit is admissible only when an
  `origin/*` ref contains it after a fetch done per ask. Finding text is read from
  `origin/main:docs/reviews/_registry/findings.jsonl`, never the working tree. By design there is
  no second admissible source:
  - unpushed work is refused;
  - a stash commit carrying ignored files is refused;
  - an ARIA implementation branch becomes askable once it is pushed (`origin/aria-impl-*`), so a
    `pre_pr_open` question about an unpushed commit is refused.
- **The response deadline holds.** The body is read in chunks against the deadline, and a reply
  completing after it is refused.
- **The transport stays private.** `system_one` binds it under a private alias. The invariant
  test flags any name, attribute, import or importlib string naming it outside the two modules.
- **More credential-shaped paths are refused:** `credentials*.json`, `service-account*.json`,
  `*.tfvars`, `*.tfstate`, `kubeconfig`, `.netrc`, `*.p8`, and `.kube/`, `.aws/` and `.docker/`.

Open for the operator: `aria-config/` has no CODEOWNERS entry. The question registry is READONLY
to ARIA's implementer and an authority surface. No human review rule is attached to it on GitHub,
and this PR does not change CODEOWNERS.

## ARIA-LOW-319

Recorded 2026-10-03, the wiring half of ARIA-LOW-252. The decision points the questions were
validated for do not ask them: the PR opener records no J0 for the findings a branch claims to
close and no R5 for its title and body against its diff, the merge authority records no J0 per
`Closes:` trailer, the judge fan-out records no J1 for tenant-scoping findings, and no planner or
implementer envelope can carry ranked candidate files (R4).

Rule: A validated reflex is asked, in shadow, at every decision point it was validated for, and
steers nothing until the operator promotes its question.
