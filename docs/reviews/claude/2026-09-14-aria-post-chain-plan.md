# ARIA post-chain plan — what the chain's closure does not cover

Recorded 2026-09-14 while the live chain (rings 1–7) was being closed. The operator's direction:
note the gaps the architecture review named, start from the most important, plan and implement
each — **after the chain runs end to end**. Every item is a registered finding with an owner and a
deadline; the order below is the execution order.

| #   | Finding                                                             | Why first                                               | Depends on |
| --- | ------------------------------------------------------------------- | ------------------------------------------------------- | ---------- |
| 1   | ARIA-HIGH-125 — nightly fitness (goldset precision/recall)          | the RSI ladder has no "better" without it               | live chain |
| 2   | ARIA-HIGH-126 — the target repo's test floor (CI quarantine)        | ARIA's breakage detection is blind there                | live chain |
| 3   | ARIA-MEDIUM-127 — operator inbox                                    | the human is the throughput bottleneck                  | —          |
| 4   | ARIA-MEDIUM-128 — deadlines organ (early warning)                   | clock bombs broke main on 2026-09-13                    | —          |
| 5   | ARIA-HIGH-122 — the adaptation loop                                 | kernel adapts to a changed condition instead of waiting | 1          |
| 6   | ARIA-MEDIUM-129 — memory usefulness                                 | "ARIA learns" becomes measurable                        | 1          |
| 7   | ORPHAN-HIGH-689 — genesis EVAL_WINDOW → ACTIVE (measured promotion) | RSI rungs 2–3                                           | 1, 5       |
| 8   | ARIA-MEDIUM-130 — CI proves containment                             | the security property CI cannot defend                  | —          |
| 9   | ARIA-MEDIUM-131 — broker adversarial review                         | one privileged boundary, reviewed on its own            | —          |
| 10  | ARIA-MEDIUM-132 — regression → revert candidate                     | a broken main should not wait a night                   | live chain |
| 11  | ARIA-HIGH-133 — kernel separable from the target repo               | the Legal/finance product line                          | 1–4        |
| 12  | ARIA-HIGH-108b / 109b — provider continuity for write roles         | "any live subscription keeps the chain moving"          | live chain |

Fixed lines the plan keeps: fitness is measured, never self-reported; the gates that judge the
kernel (judges, merge predicates, signature verification) stay operator-approved; the model-tier
write protection stays; every promotion is reversible and its reason is on the ledger.
