# Console live check (2026-10-17)

Defects found by checking the tenant console against production. Code changes only: no
production container, Redis or droplet runtime state was touched.

Owner: claude (implementation), okan (review).

## FE-MEDIUM-345

**State:** OPEN. Resolved by the PR whose commit carries `Closes:` for this ID. Deadline
2026-10-24.

### Symptom

On production `/tenant` (Company dashboard, dark theme) the Module Status list showed the words
"users" beside Human Resources and "sprout" beside Hydroponics Management, overflowing their icon
tiles. Fish Farm Management and Sensor Monitoring showed the emoji 🐟 and 📊.

### Root cause

Line references are to `main` before this fix.

A module record names its icon in Lucide's kebab-case (`auth.modules.icon`: `fish`, `users`,
`activity`, `sprout`, `bell`, `brain`;
`apps/auth-service/src/modules/system-module/entities/module.entity.ts:175`, `:218`). Nothing in
tenant-admin resolved that name to a component:

- `TenantDashboard` guessed a module code from the display name (`farm`, `hr`/`insan`,
  `sensor`/`sens`), mapped the three guessed codes to emoji and fell back to the record's icon
  name for every other module (`web/modules/tenant-admin/src/pages/TenantDashboard.tsx:73-77`,
  `:161-176`). "Human Resources" contains no `hr`, and hydroponics had no guess, so both rows
  printed the raw name, which the row rendered as text (`:469-471`).
- `TenantModules` kept a second code-to-emoji map
  (`web/modules/tenant-admin/src/pages/TenantModules.tsx:18-23`), and `ModuleCard` and
  `ModuleDetailsModal` rendered the icon field as text
  (`web/modules/tenant-admin/src/components/modules/ModuleCard.tsx:115-117`,
  `ModuleDetailsModal.tsx:24-26`).

The console already owns a typed map from Lucide names to components for the rail
(`web/shared-ui/src/components/Layout/console/railIcons.ts`), which covered four of the six
catalogue names.

### Evidence

- Screenshot of production `/tenant`: the Human Resources and Hydroponics Management rows show
  the text "users" and "sprout" where the other rows show an emoji.
- Before the fix, `TenantDashboard.spec.tsx` renders the list from records named `users`,
  `sprout`, `fish`, an unknown name and `null`, and finds no `svg` in any icon tile.

### Fix

- `railIcons.ts` is now the console's single icon vocabulary. It adds `bell` and `brain`, so
  every catalogue name resolves. `consoleIconFor(name: string | null)` returns the name's
  component, or `CONSOLE_ICON_FALLBACK` (`Package`) for `null`, an unknown name or a name off the
  object prototype.
- `ModuleIcon` (`web/modules/tenant-admin/src/components/modules/ModuleIcon.tsx`) draws a
  record's icon through `consoleIconFor`, `aria-hidden`, since the module name sits beside it.
  The dashboard list, `ModuleCard` and `ModuleDetailsModal` render through it. Both emoji maps
  and the name-based code guess are gone.
- `MyModule.icon` is `string | null`, as the GraphQL contract declares. The modules page has no
  icon in the login payload, so the refs query (`MyModuleRefs`, formerly `MyModulesWithIds`) also
  selects `icon`. `useModuleRefs` returns each module's id and icon by code.

### Tests

- `web/shared-ui/src/components/Layout/console/__tests__/railIcons.spec.ts`: known names
  resolve to their Lucide component; unknown, `null` and prototype names resolve to `Package`.
- `web/modules/tenant-admin/src/pages/__tests__/TenantDashboard.spec.tsx`: the `users`, `sprout`
  and `fish` rows each draw `svg.lucide-<name>` with an empty text content, and no element has
  the text "users" or "sprout". The unknown-name and `null` rows draw `svg.lucide-package`.
- `web/modules/tenant-admin/src/pages/__tests__/TenantModules.spec.tsx`: each card draws its
  record's icon from the refs query and the neutral glyph for a module without a record.
