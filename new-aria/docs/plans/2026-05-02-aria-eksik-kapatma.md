# ARIA — Eksik Kapatma Planı (Tight, Non-Over-Engineered)

> **Branch:** `snowball` (sadece, main'e push yok)
> **Goal:** ARIA'nın repo şeklini alma kapasitesini somut artırmak — kalıba sokmadan.
> **Non-goal:** Phase 0 kernel implementation (3-6 ay; PoC §13 decision gate'e bağlı).
> **Disiplin:** her item için **gerekçe + dosya + iş büyüklüğü + verify**. Disposable detail yok.

---

## Context

Operatör son turda 4 soruya geldi: "eksik bir şey kaldı mı?". 16 eksik enumerate ettik (Tier A-E). Operatör cevap verdi: **"sadece gerçekten gerekli olanı planla, over-engineering değil; ARIA repo şeklini alsın ki sonrasında geliştirmeler önersin, kodu düzenlesin, mimari açıdan değer üretsin."**

Bu plan 16 eksiğin **5'ini** seçer — diğer 11 ya Phase 0 kernel work'üne bağlı (henüz operatör kararı yok), ya nice-to-have, ya internal nuisance. Seçilen 5 ortak özelliği:
- **Operatöre değer üretir** (görünmez kod fixinin tersine)
- **Cheap** (her biri ≤ 1.5 saat veya tek dosya değişikliği)
- **Repo-şekil-alma kapasitesini gerçekten artırır** (kalıp dayatması değil)

---

## Plan (5 item, sıralı uygulama)

### Item 1 — DEBT-POC-002: JSX `<option>` / select-options scan (HIGH)

**Why bu item:** operatörün **ilk gün tarif ettiği pattern** budur — "FarmStatusSelect.tsx 3 option render ediyor, DB 4 enum value tutuyor". PoC şu an bu pattern'i göremiyor. DEBT-POC-002 kapatılınca operatörün başlangıç beklentisinin %100'ü PoC tarafından yakalanır.

**Dosya:** `tools/aria-poc/poc.py`

**Yapılacak (~50 LOC + Türkçe yorum bloğu):**
- Yeni fonksiyon: `detect_jsx_select_options(repo_root, fates) -> list[dict]`
- Pattern manifestleri (regex grupları):
  - `<option\s+value=["']([^"']+)["']` — dropdown options
  - `<Select[^>]*options=\{(\[[^\]]*\])\}` — Select component options array
  - `<MenuItem\s+value=["']([^"']+)["']` — Material UI menu items
- Çıktı: `{component, values[], ref: file:line, surrounding_function_name}`
- `find_drifts` extend: jsx_select_options listesini de TS enum + SQL enum ile karşılaştır; matched name → drift candidate
- Yeni claim type: `frontend_dropdown_drift` (DB enum vs UI dropdown)
- Report'ta üçlü drift gösterimi: TS enum / SQL enum / UI options — üçü farklı olabilir

**Iş büyüklüğü:** ~1-1.5 saat. Single function + extend find_drifts + extend write_report.

**Verify:**
```bash
python3 tools/aria-poc/poc.py --workspace-root . --skip-nx-graph --fail-on-drifts 100
grep -c "frontend_dropdown_drift\|jsx_select" .aria-poc/MECHANICAL_DRIFTS.json
# Expected: en az birkaç FarmStatusSelect-tarzı drift bulunmalı (web/modules/* altında)
```

**Kapanan eksik:** Tier B #6, kısmen Tier B #8 (web/modules/* surface'inden ilk sinyal).

---

### Item 2 — DEBT-POC-001: TypeScript union literal types scan

**Why bu item:** TypeScript repo'larda `type FarmStatus = 'active' | 'inactive' | 'maintenance'` enum'a tercih ediliyor. Bu repo'da kontrol etmeden bilemeyiz ama dağılım `enum:union` tahminen 3:1. Item 1 ile birlikte uygulanırsa drift surface'in ~%30'u daha açılır.

**Dosya:** `tools/aria-poc/poc.py`

**Yapılacak (~30 LOC + yorum):**
- Yeni regex: `(?:export\s+)?type\s+(\w+)\s*=\s*((?:\s*['"][^'"]+['"]\s*\|?)+)`
- Yeni fonksiyon: `detect_ts_union_types(repo_root, fates) -> list[dict]`
- Çıktıyı `find_drifts` ts_enums listesine union sources'la merge et (kind: 'enum' | 'union' marker'ıyla)
- Report'ta union vs enum görsel ayrımı

**Iş büyüklüğü:** ~30-45 dakika.

**Verify:**
```bash
python3 -c "
import json
d = json.load(open('.aria-poc/MECHANICAL_DRIFTS.json'))
unions = [e for e in d['ts_enums'] if e.get('kind') == 'union']
print(f'union types found: {len(unions)}')
"
# Expected: > 0
```

**Kapanan eksik:** Tier B #5.

---

### Item 3 — CLAUDE.md'ye ARIA pointer (cheap, yüksek discoverability)

**Why bu item:** CLAUDE.md repo'nun **operating contract**'ı; 38+ specialized agent + her dev onu okuyor. Şu an "aria" ya da "snowball" kelimesi geçmiyor. Yeni bir dev gelirse ARIA'nın varlığından habersiz olur. 5-10 satırlık pointer çok ucuz, görünürlüğü uçurur.

**Dosya:** `CLAUDE.md`

**Yapılacak:** "Extended Documentation Pointers" section'ının sonuna (mevcut `@docs/adr/`, `@docs/runbooks/`, vs. listelerinin yanına):

```markdown
## ARIA Snowball (continuous-mode meta-system, scoped to `snowball` branch)

ARIA is a repository-shaped intelligence that runs **between PR cycles** —
complementary to the 38+ specialized review agents that run **on PR cycles**.

- `@docs/aria/SPEC.md` — boundaries (3 laws, 5 engines, 3 mastery levels)
- `@docs/aria/IDENTITY.md` — behavior (daily rhythm, refusals, nuance protocol, debt discipline)
- `@docs/aria/CONTRACTS.md` — schemas (capsule, spine, finding, observation, debt) + 14 repo-shape axes + 15 adapters + Phase-1 PoC
- `@.claude/knowledge/layer-1-aria.md` — discoverable anchor for other agents
- `tools/aria-poc/poc.py` — operator decision tool (zero LLM, mechanical drift scan)
- `/aria-poc` — Claude Code slash command wrapper

**Branch policy:** ARIA work lives on the `snowball` branch. No main push without
explicit operator decision (per PoC §13 decision gate).

ARIA is NOT one of the 38 specialized agents. It is META — observes, never imposes.
Skills emerge from pressure, not predefinitions.
```

**Iş büyüklüğü:** ~10 dakika.

**Verify:**
```bash
grep -c "ARIA\|aria-poc\|docs/aria" CLAUDE.md
# Expected: > 5
```

**Kapanan eksik:** Tier C #9.

---

### Item 4 — `.claude/settings.json` agent-workspace + `.aria-poc/` deny hardening

**Why bu item:** SPEC §6.2 Layer B `.claude/settings.json` deny rules diye söz veriyor; mevcut sadece `.env` deny var. agent-workspace/ ARIA'nın yazma alanı; oradaki dosyaların **diğer 38 agent tarafından application code gibi okunması** cross-pollination riski. `.aria-poc/` runtime output'u (gitignored) ama yine de agent'ların görmesi gerekmez. Cheap güvenlik hijyeni.

**Dosya:** `.claude/settings.json`

**Yapılacak:** mevcut deny array'e ekle:

```json
{
  "permissions": {
    "deny": [
      "Read(./.env)",
      "Read(./.env.*)",
      "Read(./agent-workspace/**)",
      "Read(./.aria-poc/**)"
    ]
  },
  "hooks": { ... existing ... }
}
```

**Risk:** Bash tool'la `cat` yapan kullanıcı engellenmez — bu sadece domain agent'ların `Read` tool'unu kapsar, doğru davranış.

**Iş büyüklüğü:** ~5 dakika.

**Verify:**
```bash
python3 -c "import json; print(json.load(open('.claude/settings.json'))['permissions']['deny'])"
# Expected: 4 entries including agent-workspace and .aria-poc
```

**Kapanan eksik:** Tier C #11.

---

### Item 5 — ADR-031: ARIA Snowball as continuous-mode meta-system

**Why bu item:** Repo'nun **ADR ekosistemi** (34 canonical ADR) mimari kararları kaydeder. ARIA'nın kendisi mimari karar:
- Neden continuous-mode bir meta-system kuruyoruz (38 PR-cycle agent yetmedi mi?)
- Neden bu repo'ya bağlı (repo-shape-taking)
- Neden CLI mod (Anthropic SDK direkt değil)
- Neden 3 yasa (kernel bloat'a karşı)
- Neden 14 axis adapter set (jenerik kalıp dayatmasına karşı)

Bu sorular zamanla buharlaşır; ADR onları sabitler. Repo'nun **architectural memory**'sine giriş yapar.

**Dosya:** `docs/adr/031-aria-snowball-meta-system.md` (yeni)

**Yapılacak (~150 satır, repo'nun ADR template'ini takip):**
- Status: Accepted (snowball branch için)
- Context: 38 specialized agent + Nx + CI mevcut; PR-cycle drift'leri arasındaki sürekli-mod gözlem boşluğu
- Decision: ARIA Snowball — continuous-mode meta-system, CLI mode, repo-shape-aware
- Consequences:
  - PR-cycle ekosistemine **complementary** (replacement değil)
  - Phase 0 kernel implementation 3-6 ay yatırım gerektirir
  - PoC §13 decision gate operator-driven karar noktası
  - Branch policy: snowball-only, main'e otomatik push yok
- Alternatives considered:
  - 39'uncu specialized agent (rejected: PR-cycle constraint)
  - Standalone Python daemon with Anthropic SDK (rejected: cost + auth surface)
  - Cron-driven scripts (rejected: no skill genesis, no nuance protocol)
- References: docs/aria/SPEC.md, IDENTITY.md, CONTRACTS.md

**Iş büyüklüğü:** ~30-45 dakika.

**Verify:**
```bash
ls docs/adr/031-aria-snowball-meta-system.md
grep -c "Status:\|Context:\|Decision:\|Consequences:" docs/adr/031-aria-snowball-meta-system.md
# Expected: file exists, 4 sections present
```

**Kapanan eksik:** Tier E #16.

---

## Plan Dışı (Bilinçli Defer)

| Eksik | Niye defer | Ne zaman? |
|---|---|---|
| Tier A #1-4 (spec internal tutarsızlık) | Operator-invisible nuisance; bir sonraki büyük spec turuna ekleyebiliriz | Phase 0 kernel work başladığında doğal kapanır |
| Tier B #7 (PoC test file) | PoC throwaway; full ARIA için skill test pattern'leri zaten farklı | Phase 0 |
| Tier B #8 (hr-service kilidi) | Item 1+2 ile kısmen açılıyor; tam çözüm 13 yeni adapter implementation | Phase 0 |
| Tier C #10 (CI integration) | --fail-on-drifts var; CI workflow değişikliği başka kalıba zorla sokar | Operator karar verirse |
| Tier D #12 (/aria-cycle command) | Phase 0 work; kernel olmadan boş slash command olur | Phase 0 |
| Tier D #13 (kernel) | 3-6 ay yatırım; PoC §13 decision gate'e bağlı | Operator decision sonrası |
| Tier E #14 (invariant tests) | Sadece 4 doc + 1 PoC var; invariant test'i kuracak yüzey çok küçük | Adapter implementation başladığında doğal gerek |
| Tier E #15 (report format) | Operatör cat ile okuyor; daha fazlasına gerek yok | Operatör explicit isterse |

---

## Uygulama sırası ve toplam iş

```
Sıra: 4 → 3 → 5 → 2 → 1
```

Sıra mantığı: önce ucuz hijyen (4: settings, 3: CLAUDE.md), sonra mimari kayıt (5: ADR), sonra coverage genişletme (2: union, 1: JSX).

| # | Item | Süre | Etki |
|---|---|---|---|
| 4 | settings.json hardening | 5 dk | low |
| 3 | CLAUDE.md ARIA pointer | 10 dk | high (discoverability) |
| 5 | ADR-031 | 30-45 dk | medium (architectural memory) |
| 2 | union types scan | 30-45 dk | medium (coverage +%5-10) |
| 1 | JSX option list scan | 60-90 dk | **HIGH** (operatörün flagship case'i) |

**Toplam: ~2.5-3.5 saat. Tek seans.**

---

## Verification (uçtan uca)

Plan tamamlandığında:

```bash
# 1. PoC re-run, yeni claim type'lar görünüyor mu
python3 tools/aria-poc/poc.py --workspace-root . --skip-nx-graph --fail-on-drifts 100
python3 -c "
import json
d = json.load(open('.aria-poc/MECHANICAL_DRIFTS.json'))
print('TS enums (kind=enum):', sum(1 for e in d['ts_enums'] if e.get('kind') == 'enum'))
print('TS unions (kind=union):', sum(1 for e in d['ts_enums'] if e.get('kind') == 'union'))
print('drifts above:', len(d['drifts_above_threshold']))
"

# 2. CLAUDE.md ARIA pointer
grep -c "aria\|ARIA\|snowball" CLAUDE.md  # > 5

# 3. settings.json deny
python3 -c "import json; print(len(json.load(open('.claude/settings.json'))['permissions']['deny']))"  # >= 4

# 4. ADR-031 exists with required sections
test -f docs/adr/031-aria-snowball-meta-system.md && \
  grep -E "^(##|\*\*)\s*(Status|Context|Decision|Consequences|Alternatives)" docs/adr/031-aria-snowball-meta-system.md

# 5. Single commit on snowball branch
git log --oneline -1
git rev-parse --abbrev-ref HEAD  # snowball
```

Tüm 5 verify geçerse → tek commit, push to snowball, plan tamam.

---

## Critical files (hızlı referans)

- **Modify:** `tools/aria-poc/poc.py`, `CLAUDE.md`, `.claude/settings.json`
- **Create:** `docs/adr/031-aria-snowball-meta-system.md`
- **Read for context:** `docs/aria/CONTRACTS.md` §1.1 14 axes, `docs/adr/template.md` (ADR format), `tools/aria-poc/README.md` DEBT-POC-001/002 spec

## Existing utilities to reuse

- `find_drifts()` in `tools/aria-poc/poc.py` — extend, don't rewrite
- `write_report()` — extend, don't rewrite
- `docs/adr/template.md` — copy/adapt for ADR-031, don't invent new format
- `agent-priors-mapper` adapter spec (CONTRACTS §1.2 #13) — already encodes path → agent mapping pattern; ADR can reference

## Branch policy reminder

- Tüm değişiklikler `snowball` branch'inde
- Tek commit (5 item logically related)
- Push: `git push -u origin snowball`
- **Main'e push YOK** (operator explicit constraint)
