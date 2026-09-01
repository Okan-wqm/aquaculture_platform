# Normatif D0 Authority Sayfaları

Bu sayfalar [design](../../../superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md)
ve [PLAN](../PLAN.md) ile birlikte normatiftir. Özet metin ile burada tanımlanan kapalı sözleşme
çatışırsa daha dar/fail-closed kural uygulanır; belirsizlik effect yetkisi vermez.

- [Identity, authority ve TCB](identity-authority-tcb.md)
- [Execution ve supply chain](execution-supply-chain.md)
- [Data ve privacy](data-privacy.md)
- [Operations, reliability ve DR](operations-reliability.md)
- [GitHub delivery ve async merge](github-delivery.md)
- [GraphQL, live channel, browser ve UI](api-ui.md)
- [Verification, evidence ve freshness](verification-evidence.md)

İlişki authority'si [`../verification/program-map.jsonl`](../verification/program-map.jsonl), phase
gate authority'si [`../verification/phase-gates.json`](../verification/phase-gates.json),
readability policy authority'si
[`../verification/readability-policy.json`](../verification/readability-policy.json) olacaktır.
Bu executable D0 kayıtları runtime authority vermez; yalnız doküman bütünlüğünü fail-closed
doğrular.
