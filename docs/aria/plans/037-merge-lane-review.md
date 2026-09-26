<!-- ARIA-HISTORICAL: Historical plan document.
Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 037 — Merge lane'ini gerçekten çalışır ve güvenli hale getirmek

> **Durum:** 2026-09-26 onaylandı (okan). Bulgular ARIA-CRITICAL-214…216, ARIA-HIGH-217…223,
> ARIA-MEDIUM-224…232: `docs/reviews/claude/2026-09-26-aria-merge-lane-review.md`. Plan 034'ün
> operatör adımları ve durum satırı bu plan ve plan 036 ile değiştirilmiştir.

## Neden

Dört bağımsız inceleme gösterdi ki merge lane bu repoda hiçbir L1 PR'ı merge edemez (beş ayrı
engelleyici) ve main'deki kod üç yerden incelemesiz ARIA merge'ünün yasak yollara ulaşmasına izin
veriyor (rename, L1 kapsamı, onay kanıtı).

## Operatör kararları (2026-09-26)

1. Strict up-to-date yerine **zorunlu merge queue**. ARIA kanıtı değişmeyen PR head'ine bağlı kalır;
   queue değişikliği güncel main ile test eder.
2. Operatör onayı, **operatör hesabının GitHub üzerindeki bir eylemiyle** kanıtlanır (PR review /
   issue yorumu, API ile doğrulanır). Runner'daki `ARIA_GH_TOKEN` operatörün kişisel hesabı olamaz.
3. L1 dışı bulgular da PR üretir, **insan merge'ü için işaretlenir** ve merge lane adayı olmaz.
4. Kapanış PR'larını, CI yeşil olunca operatörün talimatıyla **Claude squash-merge eder**; M-6.1 bu
   süreci söyler.

## Birimler

| Birim | Bulgular                   | Değişiklik                                                                                                                                              |
| ----- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L     | 214, 215, 224, 211 yeniden | rename kaynağı dahil sınıflandırma; açık L1 allowlist; kanonik yol; CODEOWNERS semantiği; L1 dışı PR'lar human-merge                                    |
| O     | 216 (+ unquarantine)       | GitHub'da doğrulanan operatör onayı; `gov:`/`review:`/`ack-env:` yetki yüzeylerinden çıkar                                                              |
| M     | 217–222                    | PR head checkout; yayınlanan kanıtlar; kalıcı claim + merge anında lease; OIDC + koşuya bağlı attestation; merge queue; yayın yarışında satır kaybı yok |
| G     | 226, 227, 228              | grant/runner düzeltmeleri; freeze görünürlüğü ve kilitlenme; self-revert kısmi hata kurtarma                                                            |
| U     | 223, 225, 229, 230, 231    | unlock penceresi; panel bağımsızlığı ve yeniden deneme tavanı; sürüme bağlı precision; yayın sınırları; validated = tip                                 |
| D     | 232                        | M-6.1, plan 034, BEHAVIOUR, CURRENT_STATE, layer-1 belgeleri koda göre                                                                                  |

## Operatör adımları (plan 036'nın listesini değiştirir)

- O1b'de strict yerine: main için **zorunlu merge queue** (squash), 4 zorunlu check, imzalı commit,
  0 onay + Code Owners, conversation resolution, `enforce_admins`, force-push/silme kapalı, ruleset
  `bypass_actors: []`.
- Onaylar: grant, unfreeze, profile, promote için operatörün GitHub eylemi (birim O'nun komut
  biçimiyle).
- `ARIA_GH_TOKEN` operatörün kişisel hesabı değil, ayrı bir makine hesabı olmalı.

Onay akışı (birim O): `aria-kernel operator approval-template --surface <yüzey> alan=değer ...`
yapıştırılacak `ARIA-APPROVE ...` satırını basar. Operatör satırı kendi hesabıyla onaylar için açılan
issue'ya ya da ilgili PR'a yorum olarak veya PR review gövdesi olarak gönderir, sonra komuta
`--operator-approval-ref gh:<owner>/<repo>#<no>/comment/<id>` (review için `.../review/<id>`)
verir. Eylem düzenlenmemiş, 7 günden yeni ve `docs/aria/policy/operators.json` içindeki bir hesaptan
olmalı; bir eylem tek bir yetki verir. Yetkiyi daraltan komutlar (revoke, freeze, profili ya da
tavanı düşürmek) yalnız bir gerekçe ister.

## Doğrulama

Her birim test-önce; ilgili modüller ayrı bir baseline worktree'ye karşı (git stash yok); banned
gate'ler, authority hash; sonunda plan 034'teki mock E2E gerçek kayıtlı profil + grant ile.
