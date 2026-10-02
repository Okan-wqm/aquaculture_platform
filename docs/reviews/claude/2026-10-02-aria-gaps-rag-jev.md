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
This is the custody class of the operator-feedback key (ARIA-CRITICAL-255 (named ARCH-CRITICAL-201 in the arbiter ruling)).

Rule: Signing material that a later job must verify against lives where that job can read it, and
no runner-readable location holds operator signing authority.
