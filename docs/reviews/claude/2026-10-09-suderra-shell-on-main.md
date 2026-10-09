# Suderra shell, shared-ui skin and tenant-admin restyle on main (2026-10-09)

Context: until 2026-10-09 production served a hand-built shell image (`local-suderra-login`,
built 2026-09-21 from PR #1569's head `cc65fa4bd` plus uncommitted edits; kept as
`aqua-predeploy/shell:20261009` and `aqua-predeploy/tenant-admin:20261009`). The deploy of main
replaced it with main's shell, so tenant users lost the Suderra look. This branch
(`feat/suderra-shell-on-main`) re-expresses that look on main's primitives and tokens.

The same two gaps are recorded on `feat/land-suderra-web` (#1737) as FE-HIGH-313 and FE-HIGH-314;
that registry is not on main, so they are registered here under main's next FE numbers. When
#1737 lands, 313/314 close against the commit that closes 321/322.

Owner: claude (implementation), okan (review).

## FE-HIGH-321 — The Suderra shell and shared-ui skin is not on main

Ported, as a re-expression (no file copied from `cc65fa4bd`):

- **Login backdrop** — `ReefScene` replaces `FishBackground`. The custom element
  (`web/shell/src/components/reef/`) keeps the production scene: eight species, burst-and-coast
  swimming on three depth planes, the baitfish school, kelp and eelgrass, rays, snow, caustics,
  bubbles. The species artwork moved into SVG asset files and the shadow-root stylesheet into
  `reefScene.css` (both loaded `?raw`), so the TypeScript carries geometry and physics only and
  no colour. The reduced-motion guard of ORPHAN-MEDIUM-136 is kept and re-pinned by
  `ReefScene.spec.tsx` (no animation frame under `reduce`; the loop is cancelled on unmount).
- **Rail** — `SuderraSidebar` (shared-ui) for TENANT_ADMIN and module users; SUPER_ADMIN keeps
  `Sidebar`. Sections Overview / People & access / Modules / Communication / Account
  (`web/shell/src/layouts/tenantRail.ts`); an entry the grouping does not name is appended to
  Account, never dropped. Icons are lucide, not a hand-pasted path registry. The rail also opens
  while keyboard focus is inside it (production opened on hover only), its collapsed items keep
  their names (visually hidden labels, not `title` alone), and below `md` it is the same
  off-canvas overlay as `Sidebar`. Access, active-item and overlay behaviour now live once in
  `Layout/navShared.ts`, used by both navigations.
- **Content column** — `sd-content` (paper gradient, warm glow) and `sd-main` for tenant roles.
- **Page surface** — `web/shared-ui/src/styles/suderra.css`, imported by the shell. `sd-page`
  (page root) and `sd-surface` (a portalled dialog panel) re-assign the theme scales — white to
  parchment, gray to an ink ramp, primary to teal, success / warning / error / info to mint,
  amber, rust and sea — so every shared-ui primitive inside paints Suderra and keeps its `dark:`
  classes; the dark theme re-assigns the same scales to a deep-water ramp. The sd-_ page classes
  messaging-module is written against (page head, card, banner, empty state, chat surface) are
  defined there on the `sd-_` tokens; on main they had no stylesheet at all.
- **Tokens** — theme.css gains five `sd-*` tokens and a `[data-theme='dark']` block for the
  paper/ink pair, so `bg-sd-paper` / `text-sd-ink` follow the theme toggle.
- **Dialogs** — `Modal` paints the Suderra chrome (deep-water blurred overlay, parchment panel,
  18px radius, display-serif title) for every dialog; `surface="suderra"` on `Modal` and
  `ConfirmModal` carries the page scope into the portal.
- **Page title** — `PageHeader` reads its face from `--page-title-font` / `--page-title-weight`,
  which the scope sets to the display serif.
- **Login card** — production's spacing (header, logo, tagline, body) and the AquaMobil pill.

Main's own features are untouched: the MFA setup screen (ADR-046), `ToastProvider`,
`ActAsTenantBanner`, `UserLocaleSync`, the AI assistant drawer, the skip link, the theme toggle.

## FE-HIGH-322 — The tenant-admin Suderra restyle is not on main

Production's restyle is 194 static inline style blocks and 89 raw hex colours. On main the four
pages (dashboard, users, roles, activity) render inside `sd-page` under a Suderra eyebrow, so the
token scope gives DataTable, Badge (RoleBadge, StatusBadge), Select, Input, Button, the filters,
bulk bar and user list the Suderra palette with no per-component change. The Suderra shapes are
written once in `components/ui/suderra.ts` (card, uppercase card label, stat caption,
display-serif figure) and used by the dashboard and activity stat cards, the section cards and
`RoleCard`; `UserAvatar` takes the teal gradient. The user, role, permission, site-access and
confirmation dialogs pass `surface="suderra"`. No inline style block and no raw hex was added:
tenant-admin, shell and shared-ui stay at zero on both ratchets.

## Deliberately not ported

- Copy that states something untrue: the login chip "eu-west · 24ms", the rail's static "Live"
  status, the "End-to-end encrypted · Zero-trust session" strip, the dashboard's "of seats" /
  "active this week" labels. None has a backing value.
- Controls that do nothing: Passkey and SSO buttons, "Contact admin", the "System status" link
  (`preventDefault` only).
- The six-box OTP entry: one `one-time-code` field keeps SMS and password-manager autofill and a
  single labelled control; the field keeps the Suderra styling.
- The more translucent login card (0.58) with teal labels: over the deepest reef tone the teal
  label measures 1.7:1 (3.5:1 even with main's label colour), below AA; main's 0.78 card
  (5.8:1) and label colours stay.
- The scoped utility overrides (`.sd-page .bg-white { … }`, compat layers I–III, `sd-f2`): they
  beat every `dark:` sibling and covered only the listed utilities; the token scope replaces them.
  The farm-module part (`sd-f2`) belongs to farm-module, which this change does not touch.
- Changes in #1569's tree that are not the skin: the pinned English locale (FE-HIGH-089 made the
  shell follow the user's language), KpiCard / Card / Table rewrites, Avatar,
  SandboxedHtmlPreview, messaging WS types, api-client changes.

## Coordination with #1737

#1737 puts `sd-page space-y-6` on nine tenant-admin roots. `sd-page` spaces its children by
sibling margin in block flow (not flex gap), so that margin collapses with `space-y-6` and those
pages keep 24px rhythm. Class names are the same on both branches.

## How to look at it

No screenshots from this host. Eyeball, light and dark theme each:

- `/login` — reef scene, card; OS reduced motion paints one still frame.
- Any tenant route as TENANT_ADMIN — rail (hover, Tab into it, pin), sections, paper column;
  below 768px the hamburger opens the rail overlay.
- `/tenant`, `/tenant/users`, `/tenant/roles`, `/tenant/activity` — eyebrow, serif title,
  stat cards, teal buttons; Add User and a role dialog for the dialog scope.
- `/messaging` — the chat surface now has its stylesheet.
- As SUPER_ADMIN `/admin` — unchanged Sidebar and canvas.
