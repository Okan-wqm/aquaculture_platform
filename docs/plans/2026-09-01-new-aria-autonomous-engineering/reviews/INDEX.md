# D0 On İki-Rol İnceleme Paketi

- **Reviewed base:** `eeb401131260fe45f3f60be55fa25d023a082d18`
- **Reviewed head:** `c6065d6dac97306f147de67ef58a96e3a67524ac`
- **Binding verdict:** `CHANGES_REQUIRED`
- **Appellate authority:** [`12-appellate.md`](12-appellate.md)
- **Byte-identical sources:** [`source/INDEX.md`](source/INDEX.md)
- **Corrective mapping:** [`../CORRECTIVE-NOTE.md`](../CORRECTIVE-NOTE.md)

Bu dizin, controller'ın on iki bağımsız inceleme çıktısını içerik ve hüküm bakımından koruyan
immutable inceleme paketidir. Byte-identical kaynaklar `source/` altında tutulur; repository Markdown
biçimi reader view'lara deterministik olarak uygulanır ve iki tarafın digest'leri evidence manifestinde
ayrı ayrı kayıtlıdır.
Raporlar yeni head için kabul kanıtı değildir; yalnız `c6065d6d...` head'ine bağlı
`CHANGES_REQUIRED` verdict'ini ve supporting dissent/evidence'ı kaydeder. Daha sonraki fresh review
bu dosyaları değiştirmez; yeni bir evidence manifest/event ekler.

| Rol                     | Rapor                                                            | SHA-256                                                            |
| ----------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| integrity               | [`01-integrity.md`](01-integrity.md)                             | `656788c691fd2f44de9bffbfccde97e38a511235c91b30c897733c1bf0801743` |
| identity                | [`02-identity.md`](02-identity.md)                               | `a5f1bca7f02dc3d333da88f0bb966198ca9a4e2e61fe1fcb4248a49a395782fd` |
| authorization           | [`03-authorization.md`](03-authorization.md)                     | `96a96387d52a9faa157eaa3a69da9e854b803e3c6746f8d539c38194be346322` |
| execution-containment   | [`04-execution-containment.md`](04-execution-containment.md)     | `47d9111ed0ba840bc91e06a71a97d90485cece8c20cc8f63f575adb12bea2378` |
| supply-chain            | [`05-supply-chain.md`](05-supply-chain.md)                       | `e85469f9bc574924f0352ac893e8bd5a376c619dfa348ccb2a32c1dafd7dcbf5` |
| data-privacy            | [`06-data-privacy.md`](06-data-privacy.md)                       | `8cf2b0fc5c92811146e1afd56e81204ba5121a984b5b4a804da1a46ccc767f45` |
| cost-capacity           | [`07-cost-capacity.md`](07-cost-capacity.md)                     | `de4382d74338c9c99327bfa3e655bf769c48eb9d576d81b4f6e3f8ed8bb4d123` |
| reliability-dr          | [`08-reliability-dr.md`](08-reliability-dr.md)                   | `670f835a113accec77c58f36c086fe13e04f9a06bc7da8aada54403075a1feae` |
| github-delivery         | [`09-github-delivery.md`](09-github-delivery.md)                 | `11e5a72e7995f3cdb57cce6f162869b39f99edb33341c277aaa70f9a3d870411` |
| api-ui                  | [`10-api-ui.md`](10-api-ui.md)                                   | `044e2fceb8e3c86f3303c3a014cdb5a045395633ad776a3b1767a1e15ec7753c` |
| portability-readability | [`11-portability-readability.md`](11-portability-readability.md) | `5b113ea5dbc2755b8207662bbc87c059aa6cfd80dbbe99fbfa600a1db60410b6` |
| appellate               | [`12-appellate.md`](12-appellate.md)                             | `8b18f15641a1a759953cc19aac797767fd90dc1326858150340f765ed9701455` |

Tablodaki digest'ler materialize edilmiş raw UTF-8 file byte'larının SHA-256 değeridir.
[`verify-d0.mjs`](../verification/verify-d0.mjs) rapor sayısını, rol benzersizliğini, digest'leri,
base/head'i ve appellate verdict'ini doğrular.
