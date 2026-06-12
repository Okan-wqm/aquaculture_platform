# Nightly fuzz install toolchain MSRV review (2026-06-11)

Reviewer: edge-expert (Round-2 gözetimi sırasında nightly kırmızısı)
Scope: `.github/workflows/fuzz-st-parser-nightly.yml`, `rust-toolchain.toml`

## EDGE-MEDIUM-002 — Fuzz install adımı repo-kökü toolchain pinine takılıyor; cargo-fuzz MSRV bump'ı nightly'yi kırdı

**Severity:** MEDIUM (nightly güvenlik kapısı devre dışı — ST parser fuzz koşusu hiç başlamıyor)

**Gözlem:** 2026-06-11 nightly (run 27327944935) "Install cargo-fuzz" adımında öldü:
`cargo-platform@0.3.3 requires rustc 1.91`, etkin rustc 1.88.0. Workflow dtolnay/rust-toolchain@nightly
kuruyor AMA install adımı repo kökünde çıplak `cargo install` koşuyor — kökteki `rust-toolchain.toml`
(channel=1.88.0) rustup çözümlemesinde kazanır; nightly devre dışı kalır. Fuzz-run adımı zaten
`cargo +nightly fuzz` kullanıyor; install adımı aynı konvansiyonu kullanmıyordu. Mayın, #381'in
sens dosyalarına dokunup cache key'ini değiştirmesiyle (taze install) tetiklendi.

**Kök neden:** Tek workflow içinde iki farklı toolchain çözümleme yolu — biri pine bağışık (+nightly),
biri değil. cargo-fuzz'ın kilitli ağacındaki MSRV yükselişi (cargo-platform 0.3.3 → rustc 1.91) pin'le
çakıştı.

**Fix:** install adımı `cargo +nightly install cargo-fuzz --locked` — run adımıyla aynı konvansiyon;
hem kök pinine hem gelecek MSRV bump'larına yapısal bağışıklık. Workflow yorumu WHY'ı taşıyor.

**Doğrulama:** workflow_dispatch ile kısa koşu (max_total_time_secs küçük) — install adımının nightly
ile geçtiği görülecek; tam 23h koşu gecelik zamanlamada.
