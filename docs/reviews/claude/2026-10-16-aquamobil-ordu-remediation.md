# AquaMobil ordu denetimi — kalan bulguların kayda geçirilmesi (2026-10-16)

Kaynak: `docs/audits/aquamobil-ordu-2026-10-13/RAPOR.md` (20 okuyucu + 50 analist/hakem
kampanyası; 43f0aa3bf revizyonunda alındı). Denetimin sözleşme-tier bulgularının bir
bölümü main'de bağımsız olarak kapatıldı (MOB-HIGH-022 enum SSoT'ları, b78dfe891
read-path serileştirmesi, b80f7a787 su kalitesi tek-giriş sözleşmesi, 51d716adf v4
SUDERRA inişi konsta'yı kaldırdı). Bu dosya, main'de hâlâ açık olan doğrulanmış alt
kümeyi kayıt sistemine taşır; her kaydın `evidence` alanı denetim raporundaki
dosya:satır kanıtlarıyla birebir aynıdır.

## MOB-HIGH-027 — TankRiskBadge bilinmeyen riskLevel'i LOW yeşiliyle boyuyor

- **Kanıt:** `web/apps/aquamobil/src/components/ai/TankRiskBadge.tsx:50` (`DEFAULT_TONE = RISK_TONE.LOW`), `:67` (`|| DEFAULT_TONE`) — denetim W2-K3.
- **Sorumluluk:** Sözleşme kayması yaşandığında (ör. MCP `warning`/`attention` değeri)
  bilinmeyen veri operatöre "all clear" yeşili olarak okunuyor.

## MOB-HIGH-028 — Başarısız mesaj gönderimi 'pending' saati gibi render ediliyor

- **Kanıt:** `web/apps/aquamobil/src/components/messaging/ChatThread.tsx:560-561`
  (`_status === 'failed' ? ('pending' as const)`), `src/pages/messaging/AiChatPage.tsx:588-589`
  (aynı), `src/components/messaging/ReadReceipt.tsx:8` (`DeliveryStatus` union'ında
  `failed` yok) — denetim W2-K4.
- **Sorumluluk:** Kaybolan mesaj hâlâ gönderiliyor gibi görünüyor; kullanıcı yeniden
  denemiyor.

## MOB-HIGH-029 — Global syncError hiçbir yerde render edilmiyor

- **Kanıt:** `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:418-421` (`syncNow`
  catch bloğu `setSyncError`), `src/pages/sync/SyncStatusPage.tsx:55-56` (context'ten
  `syncError`/`clearError` çekilmiyor) — denetim orta-tier bulgusu.
- **Sorumluluk:** Senkron çöküşünde kullanıcı sıfır geri bildirim alıyor; takılan
  kuyruk "All Synced!" görünümüyle karışıyor.

## MOB-MEDIUM-030 — Logout onayı kuyruk veri kaybını bildirmiyor

- **Kanıt:** `web/apps/aquamobil/src/pages/account/AccountPage.tsx:751`
  (`message={t('m.account.logOutConfirm')}` — sabit metin), buna karşılık `:764-766`
  Clear Queue diyaloğu kalıcı silmeyi açıkça söylüyor — denetim W1-K5 zincirinin UI
  katmanı.
- **Sorumluluk:** Logout, `clearAllOperations` ile senkronlanmamış saha kayıtlarını
  kalıcı siliyor; onay metni bunu söylemediği için kullanıcı onaylı veri kaybediyor.
  (W1-K5'in kök nedeni — geçici refresh hatasının logout'a dönüşmesi — bu kaydın
  kapsamı dışında, ayrıca ele alınacak.)
