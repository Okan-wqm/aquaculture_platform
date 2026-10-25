# The finding-id space is exhausted for domain ARIA (2026-10-25)

`finding-registry add` refused with `Finding ID space exhausted for domain ARIA (maximum 999)`
(found by the D6-SEC clerk). ARIA ids 974-999 are claimed across the registry, sibling worktree
registries and the reservation ledger, so any package that registers a finding in that domain fails.

---

## PROC-HIGH-063 — the finding-id sequence is three digits, spelled by hand at every writer and reader

- **Severity:** HIGH; owner: Okan-wqm; deadline: 2026-11-04.
- **Evidence:** the sites are listed on the registry row. The allocator
  (`tools/gates/finding-registry-store.ts` `nextFindingId`) refuses above 999, and that is one of
  fifteen places that spell the sequence's width: the reservation ledger (`sequence > 999`,
  `findingId.slice(-3)`), the add-explicit shape and its message, the ORPHAN heading and explicit
  forms, `claimedSequences`, the Closes trailer grammar (`commit-msg-validator.ts`), the row schema
  pattern, and four kernel readers (`plan_origin.py`, `plan_convergence.py`,
  `adapter_quarantine.py`, `twin.py`) whose digit counts disagree with each other (`\d{3}`,
  `[0-9]{3,}`, `\d+`): `ARIA-HIGH-0999` is an id to two of them and not to the others.
- **Rule:** one owner per concept. The grammar of a finding id has one owner per language, and a
  second spelling of it is a build failure, not a review comment.
- **Failure scenario:** raising the allocator's limit to 9999 and nothing else lets
  `finding-registry add ARIA` write `ARIA-HIGH-1000`; the same id is then refused by the
  reservation ledger, by the commit-msg gate when a commit tries to close it, by the row schema
  and by the kernel, so the first four-digit finding can be recorded and never closed.
- **Fix:** `tools/gates/finding-id-grammar.ts` owns the grammar (domain, severity, a sequence of
  three digits, or four with no leading zero up to 9999), its formatting, its numeric order and
  the allocator limit with a named exhaustion error; `aria-kernel/aria_kernel/finding_id_grammar.py`
  owns the same grammar for Python. Both are held to one table
  (`tools/gates/fixtures/finding-id-grammar-table.json`), which also pins what the registry row
  schema and the reviewed-exception library admit, because a JSON file and a plain ESM script
  cannot call an owner. Every restatement moved to its owner;
  `tests/invariants/finding-id-grammar.spec.ts` fails a file under `tools/`, `tests/` or
  `aria-kernel/` that spells a finding-id regex with a digit count of its own.
- **Not changed:** existing three-digit ids stay valid and are never rewritten or aliased; the
  `F-NNN` and `DEBT-` families are different grammars and stay as they are.
