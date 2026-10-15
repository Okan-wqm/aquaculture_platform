# The hardcoded-text ratchet counts code that renders nothing (2026-10-15)

The FE-HIGH-089 ratchet in `tests/invariants/web-design-system-ratchet.spec.ts` ("ratchets
user-visible strings written in the file per package") fails on main 6f205b988 and on every PR
whose affected set includes it: farm-module counts 2616 against a ceiling of 2614. The spec throws
at the first package over its ceiling, so a second overage stays hidden behind it: `web/shell`
counts 154 against 153.

Owner: claude (implementation), okan (review).

## FE-MEDIUM-323

No user-visible string was added. Per-file counts at each ceiling commit, compared with main:

| Package                   | Ceiling (set by) | Main | Changed file             | Commit    |
| ------------------------- | ---------------- | ---- | ------------------------ | --------- |
| `web/modules/farm-module` | 2614 (b7a1ade63) | 2616 | `src/Module.tsx` 1 → 3   | 453d442da |
| `web/shell`               | 153 (5435f85ba)  | 154  | `layouts/MainLayout.tsx` | 453d442da |

The three matches 453d442da (PR #1954, SPA preload) added:

- `Module.tsx:67-70`: a JSDoc that names `<Navigate>`, matched through to `ReadonlyArray<`.
- `Module.tsx:70`: the return type `() => Promise<unknown>`.
- `MainLayout.tsx:299-303`: a JSDoc that names `<Navigate>`, matched through to `Record<`.

The one real string in `Module.tsx`, the Suspense fallback `Laster…` (line 149), was already
inside the 2614.

Cause: `HARDCODED_JSX_TEXT` (spec line 146) starts a match at any `>`, the `>` of an arrow
included, and `hardcodedText` (lines 150-155) reads the raw source. The raw-hex count in the same
spec removes comments first (line 434); this count does not.

Proposed fix (its counts are verified; it is not applied):

- `hardcodedText` blanks block and line comments with the spec's own `BLOCK_COMMENT` and
  `COMMENT_LINE`, each leaving a `;`, so no match starts inside a comment or runs across one.
- `HARDCODED_JSX_TEXT` gains the look-behind `(?<!=)`: the `>` of `=>` does not close a tag.
- A new detector test pins the cases: `<p>Hello</p>` counts 1, a JSDoc naming `<Navigate>` counts 0,
  `() => Promise<unknown>` counts 0, a comment between two tags creates no match.
- Each ceiling is lowered to its new live count; none is raised.

Checked against the TypeScript parser over the 924 `.tsx` files the check reads: the fix drops
284 matches, none of them a `JsxText` node or a text attribute, and adds none. New counts:

| Package              | Today | With the fix |
| -------------------- | ----- | ------------ |
| `aquamobil`          | 607   | 555          |
| `dashboard`          | 90    | 85           |
| `farm-module`        | 2616  | 2597         |
| `hr-module`          | 559   | 556          |
| `hydroponics-module` | 190   | 187          |
| `sensor-module`      | 3172  | 3081         |
| `tenant-admin`       | 503   | 494          |
| `shared-ui`          | 190   | 93           |
| `shell`              | 154   | 149          |

Status: OPEN. The session's permission policy refused the edit to the spec's detector as a change
to a CI gate, so this change registers the finding and the detector fix waits for okan's decision.
The other way to clear the red keeps the detector as it is: localize three real strings (two in
farm-module, one in the shell) so the counts return to their ceilings. It leaves the false
positives in the count, and the next arrow return type or JSDoc tag fails the ratchet again.

Not part of this finding: the detector's other textual approximations (a ternary's `) : x ? (`
between two tags counts; JSX text that holds a `{expression}` does not).

PR #1955 (`fix/farm-e2e-campaign-20261010`) touches none of these files and is count-neutral under
both detectors. Its ratchet run is red for the same reason and clears when the fix is on main.

Proving test: the ratchet spec, red on main 6f205b988, green with the fix, plus the detector test.
