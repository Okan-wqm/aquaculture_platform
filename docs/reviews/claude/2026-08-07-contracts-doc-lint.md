# The contract document could not be edited — 2026-08-07

## INFRA-MEDIUM-106 — `docs-check` made `docs/aria/CONTRACTS.md` effectively read-only

### What was measured

`docs-check` runs `scripts/ci/markdownlint-changed.mjs`, which lints every
changed `docs/**/*.md` — and lints the **whole file**, not the diff. Documenting
the new hook-partial vocabulary pulled `CONTRACTS.md` into that scope for the
first time since **#934**.

|                                                          |                    |
| -------------------------------------------------------- | ------------------ |
| violations in `main`'s copy, under the gate's own config | **144**            |
| last commit touching the file before this one            | `ee92a9e9e` (#934) |

The file had never been linted. The practical effect is the part worth naming:
**the next person to document a contract change inherited an unexplained red
gate**, so the ARIA contract document could not be edited without first paying a
debt nobody had been told about. A contract SSoT that cannot be updated stops
being an SSoT.

### The fix — 138 repaired, 6 scoped out

Repaired rather than exempted:

- prose and blockquote lines rewrapped to the gate's width (Prettier will not do
  this: its `proseWrap` is `preserve`, which is why the file drifted);
- bare ` ``` ` fences given a language;
- list spacing, blank-line runs and blockquote internals normalised;
- the one 578-character blockquote converted to **reference-style links**, so
  every path survives while the prose wraps. Its longest inline link was a
  single ~102-character token — unbreakable by any rewrap.

**Reflowing was verified word-for-word.** The rewrap asserts the token sequence
is identical before and after; a change that altered content would abort rather
than ship. That assertion earned its place: a first attempt broke four long JSON
string values across lines to satisfy MD013, which would have made the
documented examples **invalid JSON** — a worse defect than the lint warning it
cured. All four were reverted to their exact originals.

### Why 6 are scoped out rather than fixed

They are string values inside fenced code blocks. A 250-character JSON string
cannot be wrapped and remain JSON, and a shell line cannot be broken without
changing what it runs. MD013 measures prose readability; inside a fence there is
no prose to read and no legal way to comply. That is precisely why `tables` is
already disabled in this same config, and `code_blocks: false` is the same
judgement applied consistently.

**Measured before touching a shared gate:** on `main`'s copy the option relaxes
exactly **6 of 144** violations. It exempts code lines and nothing else — the
other 138 had to be, and were, actually fixed.
