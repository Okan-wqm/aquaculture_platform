# Inter typography and fluid page width — web console and AquaMobil (2026-10-26)

Owner request (Okan, 2026-10-26): the text face is Inter everywhere and readable; page
content follows the window (grows when it is widened, shrinks when it is narrowed).
Decisions taken with the request: Geist Mono stays for code and IDs only; forms and prose
columns keep a reading width while panels, tables and dashboards fill the page; AquaMobil
moves to Inter too. Verified against the deploy checkout (HEAD `5852fe55`, no code
difference from the production images in `web/`) and `origin/main` `33de2433b`.

## FE-MEDIUM-378 — Barlow text, a font host the CSP refuses, a frozen page

The console sets its text in Barlow, fetches its faces from a font host the production CSP
refuses, and caps the page column at 1520px (and the stack at 1920px), so a widened window
leaves the page frozen.

**Where:** `web/shared-ui/src/styles/theme.css`, `suderra.css`, `web/shell/index.html`,
`web/shell/src/console/ConsoleShell.tsx`, six sensor pages, the CSP policy and its four
generated outputs.

**Root cause chain (each link verified):**

1. `theme.css` named Barlow (body) and Barlow Condensed (display) as the tenant console's
   Industry pair, and `suderra.css` re-pointed `--font-sans` / `--font-display` at them inside
   the console scope. Inter, named in the same file and in the shell body rule, only reached
   the pages outside that scope. The product therefore did not have one text face.
2. Every face came from a Google Fonts `<link>` in `web/shell/index.html`. The production
   policy is `font-src 'self'`: the gateway's security headers
   (`apps/gateway-api/src/middleware/security-headers.middleware.ts`) and the Kubernetes
   ingress already say so; only nginx (`infrastructure/nginx/droplet.conf`) allowed the font
   hosts. Where the stricter policy is in front the faces silently fall back to system fonts;
   where it is not, each first paint tells a third party the visitor's IP.
3. `ConsoleShell`'s `<main>` carried `max-w-[1520px]` and the `.sd-stack` page rhythm
   `max-width: 1920px` with `margin-inline: auto`. Past those widths the page stopped
   growing, which is the "content does not follow the page" the owner reported. Six sensor
   pages added their own `max-w-7xl` wrapper (1280px), narrower than either cap.

**Fix (tier 1 for the frame, tier 3 for the policy):** Inter and Geist Mono are variable
fonts served from `web/shell/public/fonts` (AquaMobil: its own `public/fonts`), declared
once in `web/shared-ui/src/styles/fonts.css`, with their OFL-1.1 notices beside them and
latin-ext included for Turkish. The text tokens all name Inter; the CSP policy file no
longer lists the Google hosts and its four outputs are re-rendered; the boot-splash font
token is regenerated from `theme.css`. The caps on `<main>`, `.sd-stack` and the six sensor
page roots are removed; forms, prose columns and dialogs keep their own limits.

**Pinned by:** `tests/invariants/web-theme-token-parity.spec.ts` (FE-MEDIUM-090: every face
a token names has a self-hosted `@font-face` whose file exists, licence notices ship, no
third-party font host in the shell document or the policy),
`tests/invariants/web-console-fluid-layout.spec.ts` (no fixed pixel cap on the console
frame), `web/shell/src/layouts/__tests__/MainLayout.spec.tsx` and
`web/apps/aquamobil/src/__tests__/design-token.invariant.spec.ts`.

**Not verifiable on the host:** Inter is wider than Barlow Condensed, so rail labels, table
headers and uppercase display text need a look at 390 to 3440px in staging.

## FE-LOW-379 — font-mono still sets figures and readings

366 `font-mono` usages still set figures and readings in the mono face.

**Where:** about 170 files: `web/modules/sensor-module/src` (61), `web/apps/aquamobil/src`
(51), `web/modules/admin-panel/src` (21), `web/modules/farm-module/src` (13), and a few in
tenant-admin, hydroponics-module, shared-ui, shell and hr-module.

**Decision (owner, 2026-10-26):** Geist Mono is for code and IDs only; text and figures are
Inter with `tabular-nums`.

**Why it is not part of FE-MEDIUM-378:** the change needs a per-usage classification
(identifier or code versus reading or number); a mechanical replace would turn device serials
and register addresses into proportional text. It ships as the next PR of the program (UI-0b),
deadline 2026-11-02, so it is a tracked phase and not a remainder of the typography change.
