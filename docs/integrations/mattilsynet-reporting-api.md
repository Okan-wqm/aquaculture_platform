# Mattilsynet / Norwegian Government Aquaculture Reporting APIs — Reference

> Compiled 2026-07-06 from official Mattilsynet/Digdir/Lovdata/Altinn/Fiskeridirektoratet pages,
> Mattilsynet's official GitHub examples, and cross-checked against this repo's live integration
> (`apps/farm-service/src/regulatory/`). Purpose: the durable in-repo reference so nobody has to
> re-crawl the government sites. Update this file when the official swagger changes.
>
> Confidence legend used below:
> **[C]** confirmed from official page content · **[I]** inferred, not directly quoted ·
> **[L]** as implemented in our codebase (claims swagger alignment — re-verify against live swagger).

## 1. Overview — "Maskinell innrapportering via API innen akvakultur-området"

Landing page: <https://www.mattilsynet.no/om-mattilsynet/api/maskinell-innrapportering-via-api-innen-akvakultur-omradet>

- APIs let operators report directly from their own systems (fagsystem); Mattilsynet recommends
  this over manual Altinn forms. **[C]**
- Every API **mirrors the corresponding Altinn 3.0 form** — the same field-content guidance applies. **[C]**
- Swagger docs describe the REST API + JSON schemas; **dev and prod environments** exist. **[C]**
- Auth: **Bearer access token from Maskinporten**; scope pattern
  **`mattilsynet:akvakultur.innrapportering.[tjeneste]`**. **[C]**
- Some datapoints are auto-resolved server-side (company name from Brønnøysundregistrene, locality
  name from Akvakulturregisteret). **[C]**
- Manual fallback: all forms remain available in Altinn. **[C]**

### Base URLs
| Env | Host | Docs |
|---|---|---|
| Dev | `https://innrapportering-api.fisk-dev.mattilsynet.io` **[C]** | `/docs/` |
| Prod | `https://innrapportering-api.fisk.mattilsynet.io` **[I/L]** | `/docs/` |

## 2. Reporting services, scopes, deadlines

| Service | Maskinporten scope | Frequency / deadline |
|---|---|---|
| **Lakselus** (sea lice) | `mattilsynet:akvakultur.innrapportering.lakselus` **[C]** | Weekly; deadline **Tuesday of the following week** **[C]** |
| **Settefisk** (juvenile/smolt) | `mattilsynet:akvakultur.innrapportering.settefisk` **[C]** | Monthly; by the **7th of the following month** **[C]** |
| **Slakt** (slaughter — planned + executed, one scope, two forms) | `mattilsynet:akvakultur.innrapportering.slakt` **[C]** | Planned: **Thursday 24:00 the week before**, correctable until Tuesday 09:00 of slaughter week. Executed: per slaughter week; all due by the **7th of the following month** **[C]** |
| **Rensefisk** (cleaner fish) | `mattilsynet:akvakultur.innrapportering.rensefisk` **[C]** | Monthly; by the **7th** — API service live from **1 Jan 2026** (previously part of Fiskeridir's biomass report) **[C]** |

No API service exists (searched exhaustively, 2026-07) for: standalone grow-out **mortality**
(embedded in settefisk/rensefisk/biomass reports instead), **welfare-incident notification**
(Altinn form only: "Varsling av hendelser som gir dårlig velferd for oppdrettsfisk"), and
**rømming/escape** (Fiskeridirektoratet Altinn form "Melding om rømming", immediate). **[C/I]**

Migration note: the legacy sea-lice API (scope `mattilsynet:akvakultur.lakselusrapportering`,
Altinn2) was decommissioned — migration deadline **1 Feb 2026**. **[C]**
API support contact: `postmottak@mattilsynet.no`. **[C]**

## 3. Endpoints and payload schemas

As implemented in `apps/farm-service/src/regulatory/mattilsynet-api.service.ts` (claims swagger
alignment) **[L]** — re-verify against the live `/docs/` swagger before schema-sensitive changes:

```
POST /api/lakselus/v1/lakselus      # sea lice report
POST /api/rensefisk/v1/rensefisk    # cleaner fish report
POST /api/settefisk/v1/settefisk    # smolt report
POST /api/slakt/v1/planlagt         # planned slaughter
POST /api/slakt/v1/utfort           # executed slaughter
```
Headers: `Authorization: Bearer <maskinporten-token>`, `Client-Id: <client id>` (Client-Id not
seen in official snippets — unverified), JSON in/out.

### Common payload base (all reports) [L]
- `klientReferanse` — client-generated UUID; idempotency/traceability key, echoed back.
- `organisasjonsnummer` — 9-digit org number (string).
- `lokalitetsnummer` — **number** (5-digit, 10000–99999) from Akvakulturregisteret.
- `kontaktperson { navn, epost, telefonnummer }` — required.
- Success returns Mattilsynet `referanse`; errors carry `feilmelding` + `valideringsfeil[] { felt, melding }`.

### Lakselus (weekly) [L, field requirements match lakselusforskriften § 10 [C]]
- `rapporteringsår`, `rapporteringsuke` (1–53), **`sjøtemperatur`** (°C, measured at 3 m depth at
  least weekly per regulation).
- `lusetelling { voksneHunnlus, bevegeligeLus, fastsittendeLus }` — average per fish across the
  three counting stages (adult females / mobiles / attached).
- `ikkeMedikamentelleBehandlinger[]`: type ∈ {TERMISK_BEHANDLING, MEKANISK_BEHANDLING,
  FERSKVANNSBEHANDLING, ANNEN_BEHANDLING}, `gjennomførtFørTelling`, `heleLokaliteten`,
  `antallMerder?`, `beskrivelse?`.
- `medikamentelleBehandlinger[]`: type ∈ {FORBEHANDLING, BADEBEHANDLING, ANNEN_BEHANDLING} +
  `virkestoff { type ∈ {AZAMETHIPHOS, CYPERMETHRIN, DELTAMETHRIN, IMIDAKLOPRID, HYDROGENPEROKSID,
  DIFLUBENZURON, EMAMECTIN_BENZOAT, TEFLUBENZURON, ANNET_VIRKESTOFF}, styrke {verdi, enhet},
  mengde {verdi, enhet} }`.
- `kombinasjonsbehandlinger[]`, `resistensMistanker[] { resistens, årsak ∈ {BIOESSAY,
  NEDSATT_BEHANDLINGSEFFEKT, SITUASJONEN_I_OMRÅDET, ANNEN_ÅRSAK} }`,
  `følsomhetsundersøkelser[] { utførtDato, laboratorium, resistens, testresultat ∈ {FØLSOM,
  NEDSATT_FØLSOMHET, RESISTENS} }`.
- Counting rules (regulation, not API): every ≤7 days at ≥4 °C, every ≤14 days at <4 °C;
  20 fish/pen (weeks 14–21) and 10 fish/pen (weeks 22–13) south of Nord-Trøndelag; report the
  pen average. **[C]** (lakselusforskriften: <https://lovdata.no/dokument/SF/forskrift/2012-12-05-1140>)

### Settefisk (monthly) [L, matches official form summary [C]]
- `rapporteringsmåned`, `rapporteringsår`,
  `produksjonsenheter[] { karId, artskode (FAO code, e.g. SAL), snittvektGram,
  beholdningVedMånedsslutt, antallAvlivet, antallSelvdød, antallFlyttetEksternt }`.

### Rensefisk (monthly) [L]
- `rapporteringsmåned`, `rapporteringsår`, `samdriftOrganisasjonsnumre[]?`,
  `produksjonssyklusStart?`, `tørrforKg?`, `våtforKg?`.
- `produksjonsenheter[] { merdId, arter[] { artskode ∈ {USB (lumpfish), BER (berggylt),
  GRO (grønngylt), BNB (bergnebb)}, opprinnelse ∈ {UKJENT, VILLFANGET, OPPDRETTET,
  VILLFANGET_OG_OPPDRETTET}, beholdningVedForrigeMånedsslutt, utsett { antallFlyttetInn, antallNy },
  uttak { antallAvlivetSykdom, antallAvlivetSkader, antallAvlivetAvmagret,
  antallAvlivetForeståendeHåndteringAvLaksen, antallAvlivetForeståendeUgunstigLevemiljø,
  antallAvlivetSkalIkkeBrukes, antallSelvdød, antallFlyttetUt, antallKanIkkeGjøresRedeFor } } }`
  — i.e. mortality by 9 explicit causes.

### Slakt (weekly) [L, matches the official two-form model [C]]
- Planned: `uke`, `år`, `godkjenningsnummer` (slaughter-facility approval no., 1–6 alphanumeric),
  `planlagteLokaliteter[] { organisasjonsnummer, lokalitetsnummer,
  ukeplanPerArt[] { artskode, mandagKg…søndagKg } }` (gutted weight per weekday per species).
- Executed: `slakteuke`, `slakteår`, `godkjenningsnummer`,
  `utførteLokaliteter[] { organisasjonsnummer, lokalitetsnummer, arter[] { art, superiorKg,
  ordinærKg, produksjonsfiskKg, utkastKg } }` — Norwegian quality classes, gutted weight.

## 4. Maskinporten onboarding + auth flow

1. **Org prerequisite**: Norwegian org number; sign Digdir's terms (bruksvilkår) → access to
   **Samarbeidsportalen** (self-service). **[C]**
2. **Create the OAuth2 integration** with the wanted `mattilsynet:akvakultur.innrapportering.*`
   scopes. Mattilsynet's scopes are openly grantable (dev + prod). A supplier creates the
   integration as **itself**, not "on behalf of a customer". **[C]**
3. **Keys**: virksomhetssertifikat (Buypass/Commfides) or a self-generated asymmetric key
   registered on the integration (recommended). **[C]**
4. **Delegation**: the farming company delegates the API resource to the supplier **in Altinn**;
   the supplier then requests tokens **onBehalfOf** the consumer org so submissions are attributed
   correctly. **[C]**

JWT-bearer grant (RFC 7523) **[C]**:
- Assertion: `aud` = `https://maskinporten.no/` (prod) / `https://test.maskinporten.no/` (test);
  `iss` = client_id; `scope` = space-separated; `exp − iat ≤ 120 s`; unique `jti`; signed with the
  registered key.
- `POST {env}/token` with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`.
- Tokens are short-lived (`expires_in: 119` in Mattilsynet's official example) — fetch per
  submission, do not cache long. **[C]**
- Typical 401/403: expired token, wrong scope, dev integration against prod (or vice versa). **[C]**
- Official example: <https://github.com/Mattilsynet/maskinporten-examples> (Kotlin, PEM,
  `onBehalfOf`). **[C]**

Our implementation: `apps/farm-service/src/regulatory/maskinporten.service.ts` (per-tenant
credentials AES-256-GCM encrypted at rest in `regulatory_settings`; token cache per
tenant+scopes).

## 5. Fiskeridirektoratet — monthly biomass report (månedsrapport biomasse)

- Legal basis: **akvakulturdriftsforskriften § 44**
  (<https://lovdata.no/dokument/SF/forskrift/2008-06-17-822>). **[C]**
- Channel: **Altinn form FD-0001** — **no public submission API exists** (negative result from
  exhaustive search, 2026-07; watch <https://api.fiskeridir.no/catalog/>). Deadline: **7th of the
  following month** when fish are present. **[C]**
- Content **[C]**: per production unit — stocking/utsett (species, number, year class);
  inventory/beholdning + biomass per species; slaughter (number, weight, condition); removal of
  live fish (flytting); losses/mortality by cause; feed consumption (kg + type); available volume.
- From 2026-01-01 cleaner-fish data moved out of this report into Mattilsynet's rensefisk API. **[C]**
- Read-only open data: Akvakulturregisteret at `https://api.fiskeridir.no/pub-aqua/`
  (swagger `/pub-aqua/api/swagger-ui/`). **[C]**

## 6. Companion / validation APIs

- **Mattilsynet public data**: scope `mattilsynet:akvakultur.offentlig.data`; consolidated public
  datasets + **push subscription** service. **[C]**
- **BarentsWatch Fish Health API** (free): lice/disease/treatments/escapes per locality/week,
  updated daily 06:00 — useful to verify a submitted lice report actually landed, and for
  neighbor-locality lice pressure. OAuth2 client_credentials at
  `https://id.barentswatch.no/connect/token`; docs
  <https://developer.barentswatch.no/docs/fishhealth>. **[C]**

## 7. Report identity keys

| Key | Meaning |
|---|---|
| `organisasjonsnummer` | 9-digit org number of the reporting/owning entity |
| `lokalitetsnummer` | 5-digit numeric locality ID from Akvakulturregisteret — primary site key in every report |
| `klientReferanse` | Client UUID per submission — idempotency + traceability |
| `godkjenningsnummer` | Slaughter-facility approval number (slakt reports) |
| `karId` / `merdId` | Production-unit IDs (settefisk tank / rensefisk cage) |
| `artskode` | FAO species code (e.g. SAL; cleaner fish: USB/BER/GRO/BNB) |

In this platform: org number + site→lokalitetsnummer mappings + godkjenningsnummer live in
`regulatory_settings` (`apps/farm-service/src/regulatory/entities/regulatory-settings.entity.ts`);
every submission row records `lokalitetsnummer` + `klientReferanse`
(`regulatory-report.entity.ts`, unique on `(tenantId, reportType, klientReferanse)`).

## 8. Open items — verify against live swagger

The proxy in CI/dev sessions blocks `*.mattilsynet.io`; these must be verified from an unblocked
network (or the dev environment) before schema-sensitive changes:

1. Exact **prod hostname** and endpoint paths/version segments (currently [L]).
2. Authoritative **JSON Schemas** per service (required/optional, formats, maxima) — diff against
   `dto/regulatory-inputs.dto.ts`.
3. Whether the **`Client-Id` header** is actually required.
4. Response envelope details (`referanse` format, full error model).
5. Rate limits and dev-environment test data (test org/lokalitet numbers).
6. Whether welfare-varsling or standalone mortality ever gets an API scope.

## 9. Source index

Official pages (content confirmed via search snippets where fetch was blocked):
Mattilsynet API overview & per-service pages, lakselus guidance + counting rules, settefisk/slakt/
rensefisk form pages, Altinn form registry entries (incl. FD-0001 and Melding om rømming),
docs.digdir.no Maskinporten guides, lovdata forskrifter (2012-12-05-1140, 2008-06-17-822),
api.fiskeridir.no catalog + pub-aqua, developer.barentswatch.no, github.com/Mattilsynet.
Full URL list: see the research compilation in the git history of this file / the plan document
`docs/plans/2026-07-06-mattilsynet-automated-reporting/PLAN.md`.
