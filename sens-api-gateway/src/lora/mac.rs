//! LoRaWAN 1.0.x MAC Durum Makinesi (State Machine)
//!
//! LoRaWAN protokolunun ag sunucusu (network server) katmanini uygular.
//! Gelen uplink paketlerini parse eder, MIC dogrulamasi yapar,
//! payload'i cozer ve codec ile sensor degerlerine donusturur.
//!
//! # LoRaWAN MAC Katmani Sorumlulukları
//! - **Join-Request isleme**: OTAA cihazlarin ag'a katilma isteklerini yonetir
//! - **Join-Accept olusturma**: Oturum anahtarlarini turetir, DevAddr atar
//! - **Data Uplink isleme**: MIC dogrulama, payload sifre cozme, codec decode
//! - **Frame Counter yonetimi**: Replay attack koruması icin sayac takibi
//! - **Downlink kuyrugu**: Cihazlara gonderilecek verileri siralar
//!
//! # Kullanilan Moduller
//! - `crypto`: MIC hesaplama, payload sifreleme, oturum anahtar turetme
//! - `codec`: Payload decode (Cayenne LPP, Raw Binary)
//! - `session`: SQLite tabanli kalici oturum deposu
//! - `types`: Paylasilam veri yapilari

// SAFETY: LoRaWAN MAC processing operates on protocol-defined fixed-offset fields
// in PHYPayload byte arrays. All index bounds are specified by LoRaWAN 1.0.x spec.
#![allow(clippy::indexing_slicing)]

use std::collections::HashMap;
use std::time::Instant;
use tracing::{debug, error, info, warn};

use super::codec::decode_payload;
use super::crypto::{
    build_b0, compute_mic, derive_session_keys, encrypt_frm_payload, encrypt_join_accept,
    verify_mic,
};
use super::downlink_queue::{BoundedDownlinkQueue, EnqueueOutcome};
use super::session::SessionStore;
use super::types::{DevAddr, DevEui, LoRaDeviceConfig, LoRaRegion, LoRaStats, RxPacket, TxPacket};

// ============================================================================
// MAC Olaylari (Events)
// ============================================================================

/// MAC katmanindan uretilen olaylar
///
/// LoRaMac bir uplink paketini isleyip sonucunu bu olaylarla bildirir.
/// Actor katmani (mod.rs) bu olaylari alip uygun aksiyonlari alir
/// (process image guncelleme, MQTT yayinlama, downlink gonderme vb.)
#[derive(Debug)]
pub enum MacEvent {
    /// Basarili uplink veri paketi islendi
    /// Codec decode sonuclari dahil — her (String, f64) bir sensor degeridir
    UplinkData {
        dev_eui: DevEui,
        dev_addr: DevAddr,
        f_port: u8,
        payload: Vec<u8>,
        f_cnt: u32,
        rssi: i16,
        snr: f32,
        /// Codec decode sonuclari: (tag_adi, deger) ciftleri
        decoded_values: Vec<(String, f64)>,
    },

    /// Join-accept paketi hazir — radyo uzerinden gonderilmeli
    /// dev_eui ve dev_addr: MQTT join event yayini icin gerekli
    SendJoinAccept {
        tx_packet: TxPacket,
        dev_eui: DevEui,
        dev_addr: DevAddr,
    },

    /// Downlink paketi hazir — radyo uzerinden gonderilmeli
    SendDownlink { tx_packet: TxPacket },

    /// Frame sayaci sifirlandi (cihaz yeniden baslatilmis olabilir)
    /// Guvenlik uyarisi: Bu durum bir replay attack'i de gosterebilir
    FrameCounterReset {
        dev_eui: DevEui,
        old_cnt: u32,
        new_cnt: u32,
    },

    /// Bilinmeyen cihazdan paket alindi — kayitli degil
    UnknownDevice {
        dev_eui: Option<DevEui>,
        dev_addr: Option<DevAddr>,
    },
}

// ============================================================================
// Downlink Kuyrugu (Downlink Queue)
// ============================================================================

/// Cihaza gonderilecek downlink verisi
///
/// Class A cihazlara downlink sadece uplink sonrasi RX1/RX2 pencerelerinde
/// gonderilebilir. Bu yuzden downlink'ler kuyrukta bekletilir.
#[derive(Debug, Clone)]
pub struct DownlinkItem {
    /// Hedef cihaz adresi
    pub dev_addr: DevAddr,
    /// Gonderilecek uygulama verisi (sifrelenmemis)
    pub payload: Vec<u8>,
    /// Uygulama port numarasi (1-223)
    pub f_port: u8,
    /// Onaylama gerekli mi? (confirmed downlink)
    pub confirmed: bool,
    /// Oncelik (dusuk = daha oncelikli)
    pub priority: u8,
}

// ============================================================================
// LoRaWAN MAC Durum Makinesi
// ============================================================================

/// LoRaWAN MAC katmani ana yapisi
///
/// Gelen tum uplink paketlerini isler, oturum yonetimi yapar
/// ve downlink kuyrugunu yonetir.
/// Varsayilan join accept hiz limiti (saniyede)
const DEFAULT_JOIN_ACCEPT_BUDGET_PER_SEC: u32 = 10;

pub struct LoRaMac {
    /// Aktif bolge konfigurasyonu — kanal frekanslari ve TX limitleri belirler
    region: LoRaRegion,
    /// 3-byte ag kimligi — Join-Accept mesajinda cihaza gonderilir
    net_id: [u8; 3],
    /// SQLite tabanli oturum deposu — anahtarlar ve frame sayaclari
    sessions: SessionStore,
    /// Kayitli cihaz konfigurasyonlari — DevEUI bazli harita
    device_configs: HashMap<DevEui, LoRaDeviceConfig>,
    /// Bekleyen downlink mesajlari — sinirli kuyruk (per-DevAddr derinlik +
    /// global sert sinir + TTL). Sinirsiz buyume yapisal olarak imkansizdir.
    downlink_queue: BoundedDownlinkQueue,
    /// Istatistik sayaclari
    stats: LoRaStats,
    /// DevAddr atamasi icin sayac (basit artimli atama)
    next_dev_addr_counter: u32,
    /// RX1 gecikme suresi (varsayilan, saniye)
    rx1_delay: u8,
    /// Join accept hiz sinirlamasi — SX1302 TX kapasitesini korur
    /// Her saniye bu butce sifirlanir, her join-accept gonderiminde 1 duser
    join_accept_budget: u32,
    /// Son butce sifirlama zamani
    last_budget_reset: Instant,
    /// Saniye basina maksimum join accept sayisi
    max_join_accepts_per_sec: u32,
    /// Bilinmeyen cihaz rate limiting izleyicisi
    /// Key: DevEUI hex string, Value: (istek sayisi, ilk gorulme zamani)
    /// 5 dakika icinde 10+ join-request gelirse cihaz banlenir
    unknown_device_tracker: HashMap<String, (u32, Instant)>,
}

impl LoRaMac {
    /// Yeni MAC durum makinesi olusturur
    ///
    /// # Parametreler
    /// - `region`: LoRa frekans bolge plani (EU868, US915, vb.)
    /// - `net_id`: 3-byte ag kimligi (join-accept icin)
    /// - `sessions`: SQLite oturum deposu
    /// - `rx1_delay`: RX1 penceresi gecikme suresi (saniye, varsayilan 1)
    pub fn new(region: LoRaRegion, net_id: [u8; 3], sessions: SessionStore, rx1_delay: u8) -> Self {
        info!(
            "LoRaWAN MAC baslatiliyor: bolge={:?}, net_id={:02X}{:02X}{:02X}, rx1_delay={}s",
            region, net_id[0], net_id[1], net_id[2], rx1_delay
        );

        Self {
            region,
            net_id,
            sessions,
            device_configs: HashMap::new(),
            downlink_queue: BoundedDownlinkQueue::new(),
            stats: LoRaStats::default(),
            next_dev_addr_counter: 0x0001,
            rx1_delay,
            join_accept_budget: DEFAULT_JOIN_ACCEPT_BUDGET_PER_SEC,
            last_budget_reset: Instant::now(),
            max_join_accepts_per_sec: DEFAULT_JOIN_ACCEPT_BUDGET_PER_SEC,
            unknown_device_tracker: HashMap::new(),
        }
    }

    /// Istatistik referansi dondurur
    pub fn stats(&self) -> &LoRaStats {
        &self.stats
    }

    /// Mevcut istatistiklerin kopyasini dondurur
    pub fn stats_snapshot(&self) -> LoRaStats {
        self.stats.clone()
    }

    /// Bilinmeyen cihaz izleyicisini temizler (suresi dolmus entry'leri kaldirir)
    /// Memory leak onleme icin periyodik olarak cagrilmali (ornegin her 10 dakikada)
    pub fn cleanup_unknown_device_tracker(&mut self) {
        let ban_duration = std::time::Duration::from_secs(300); // 5 dakika
        let now = Instant::now();
        self.unknown_device_tracker
            .retain(|_, (_, first_seen)| now.duration_since(*first_seen) < ban_duration);
    }

    // ========================================================================
    // Cihaz Yonetimi (Device Management)
    // ========================================================================

    /// Yeni cihaz ekler
    ///
    /// Cihaz yapilandirmasi backend'den gelir. OTAA cihazlar icin
    /// AppKey bu yapilandirmada bulunur ve join-request isleme icin kullanilir.
    pub fn add_device(&mut self, config: LoRaDeviceConfig) {
        info!(
            "LoRa cihaz eklendi: dev_eui={}, activation={:?}, class={:?}, codec={:?}",
            config.dev_eui, config.activation, config.device_class, config.codec
        );
        self.device_configs.insert(config.dev_eui, config);
    }

    /// Cihaz kaldirir
    pub fn remove_device(&mut self, dev_eui: &DevEui) {
        if self.device_configs.remove(dev_eui).is_some() {
            info!("LoRa cihaz kaldirildi: dev_eui={}", dev_eui);
        } else {
            warn!("LoRa cihaz bulunamadi: dev_eui={}", dev_eui);
        }
    }

    /// Kayitli cihaz sayisini dondurur
    pub fn device_count(&self) -> usize {
        self.device_configs.len()
    }

    /// Downlink kuyruğuna mesaj ekler
    ///
    /// Mesaj, cihaz bir sonraki uplink gonderdikten sonra
    /// RX1/RX2 pencerelerinde iletilir (Class A).
    ///
    /// Kuyruk sinirlidir: hedef DevAddr icin derinlik siniri dolu ise yeni
    /// mesaj reddedilir (`RejectedDevAddrFull` doner); global sinir dolu ise
    /// en eski bekleyen downlink cikarilir. Geri-basinc kararlari icin
    /// `EnqueueOutcome` dondurulur.
    pub fn queue_downlink(&mut self, item: DownlinkItem) -> EnqueueOutcome {
        let dev_addr = item.dev_addr;
        let f_port = item.f_port;
        let payload_len = item.payload.len();
        let confirmed = item.confirmed;

        let outcome = self.downlink_queue.enqueue(item);
        match outcome {
            EnqueueOutcome::Accepted => {
                debug!(
                    "Downlink kuyruga eklendi: dev_addr={}, f_port={}, {} byte, confirmed={}",
                    dev_addr, f_port, payload_len, confirmed
                );
            }
            EnqueueOutcome::AcceptedEvictedLowerValue => {
                warn!(
                    "Downlink kuyruga eklendi ancak bir sinir doluydu — en az degerli \
                     (onaylanmamis/dusuk oncelikli/eski) bekleyen downlink cikarildi: \
                     dev_addr={}, f_port={}, {} byte",
                    dev_addr, f_port, payload_len
                );
            }
            EnqueueOutcome::RejectedDevAddrFull => {
                warn!(
                    "Downlink reddedildi — dev_addr={} icin derinlik siniri ({}) dolu ve \
                     yeni gelen bekleyenlerden daha degerli degil; kuyruga alinmadi.",
                    dev_addr,
                    super::downlink_queue::MAX_DOWNLINK_PER_DEV_ADDR
                );
            }
            EnqueueOutcome::RejectedQueueFull => {
                warn!(
                    "Downlink reddedildi — global kuyruk ({}) dolu ve yeni gelen kuyruktaki \
                     en az degerli girisden daha degerli degil; kuyruga alinmadi: dev_addr={}",
                    super::downlink_queue::MAX_DOWNLINK_QUEUE,
                    dev_addr
                );
            }
        }
        outcome
    }

    // ========================================================================
    // Uplink Isleme (Uplink Processing)
    // ========================================================================

    /// Ana uplink isleme fonksiyonu
    ///
    /// Gelen her RF paketini parse eder ve uygun handler'a yonlendirir.
    /// PHYPayload yapisi: MHDR(1 byte) | MACPayload(N byte) | MIC(4 byte)
    ///
    /// # MHDR (MAC Header) Yapisi
    /// Bits [7:5] = MType (mesaj tipi):
    /// - 000 = Join-Request
    /// - 001 = Join-Accept
    /// - 010 = Unconfirmed Data Up
    /// - 011 = Unconfirmed Data Down
    /// - 100 = Confirmed Data Up
    /// - 101 = Confirmed Data Down
    ///
    /// # Parametreler
    /// - `pkt`: SX1302'den alinan ham RF paketi
    ///
    /// # Donus
    /// Isleme sonucu olusturulan MAC olaylari listesi
    pub fn process_uplink(&mut self, pkt: &RxPacket) -> Vec<MacEvent> {
        self.stats.packets_received += 1;

        // CRC kontrolu — hatali paketler atilir
        if !pkt.crc_ok {
            self.stats.crc_errors += 1;
            debug!("CRC hatali paket atildi, freq={} Hz", pkt.freq_hz);
            return vec![];
        }

        // PHYPayload en az 5 byte olmali: MHDR(1) + minimal payload + MIC(4)
        if pkt.payload.len() < 5 {
            warn!(
                "Cok kisa paket: {} byte (minimum 5 gerekli)",
                pkt.payload.len()
            );
            return vec![];
        }

        // MHDR'den mesaj tipini cikart (ust 3 bit)
        let mhdr = pkt.payload[0];
        let mtype = (mhdr >> 5) & 0x07;

        match mtype {
            // 000 = Join-Request
            0x00 => self.handle_join_request(pkt),
            // 010 = Unconfirmed Data Up
            0x02 => self.handle_data_uplink(pkt, false),
            // 100 = Confirmed Data Up
            0x04 => self.handle_data_uplink(pkt, true),
            // Diger mesaj tipleri (downlink, proprietary vb.)
            other => {
                debug!("Desteklenmeyen mesaj tipi: MType=0x{:02X}", other);
                vec![]
            }
        }
    }

    // ========================================================================
    // Join-Request Isleme
    // ========================================================================

    /// Join-Request paketini isler
    ///
    /// # Join-Request Yapisi (LoRaWAN 1.0.x Spec 6.2.4)
    /// ```text
    /// MHDR(1) | AppEUI(8) | DevEUI(8) | DevNonce(2) | MIC(4)
    /// ```
    /// Toplam: 23 byte
    ///
    /// # Islem Adimlari
    /// 1. Payload uzunlugu dogrulama (23 byte)
    /// 2. AppEUI ve DevEUI parse etme
    /// 3. Cihazin kayitli olup olmadigini kontrol etme
    /// 4. MIC dogrulama (AppKey ile)
    /// 5. Oturum anahtarlarini turetme (NwkSKey, AppSKey)
    /// 6. DevAddr atama
    /// 7. Join-Accept paketi olusturma ve gonderme
    fn handle_join_request(&mut self, pkt: &RxPacket) -> Vec<MacEvent> {
        self.stats.join_requests += 1;

        // Join storm korumasi — SX1302 TX kapasitesini asmayi onler
        // Her saniye butce sifirlanir, butce doluysa join-accept gonderilmez
        let now = Instant::now();
        if now.duration_since(self.last_budget_reset).as_secs() >= 1 {
            self.join_accept_budget = self.max_join_accepts_per_sec;
            self.last_budget_reset = now;
            self.stats.join_storm_rejects = 0;
        }
        if self.join_accept_budget == 0 {
            // Budget yeni dolduysa warn, tekrarlayan reddlerde debug (log spam onleme)
            self.stats.join_storm_rejects += 1;
            if self.stats.join_storm_rejects == 1 {
                warn!(
                    "Join storm korumasi: join-accept butcesi doldu ({}/sn), istekler reddediliyor. \
                     SX1302 TX kapasitesi korunuyor.",
                    self.max_join_accepts_per_sec
                );
            } else {
                debug!(
                    "Join storm: istek reddedildi (toplam {} red)",
                    self.stats.join_storm_rejects
                );
            }
            return vec![];
        }

        // Join-Request tam olarak 23 byte olmali
        if pkt.payload.len() != 23 {
            warn!(
                "Gecersiz join-request boyutu: {} byte (23 bekleniyor)",
                pkt.payload.len()
            );
            return vec![];
        }

        // AppEUI ve DevEUI'yi payload'dan cikart (little-endian, ters sirada)
        // LoRaWAN spec: Join-Request'te AppEUI ve DevEUI LSB-first gonderilir
        let mut app_eui_bytes = [0u8; 8];
        app_eui_bytes.copy_from_slice(&pkt.payload[1..9]);
        app_eui_bytes.reverse(); // LSB-first -> MSB-first

        let mut dev_eui_bytes = [0u8; 8];
        dev_eui_bytes.copy_from_slice(&pkt.payload[9..17]);
        dev_eui_bytes.reverse(); // LSB-first -> MSB-first

        let dev_eui = DevEui(dev_eui_bytes);

        // DevNonce — cihazin urettigi 2-byte rastgele deger
        let dev_nonce = [pkt.payload[17], pkt.payload[18]];

        info!(
            "Join-Request alindi: dev_eui={}, RSSI={} dBm, SNR={:.1} dB",
            dev_eui, pkt.rssi, pkt.snr
        );

        // Cihazin kayitli olup olmadigini kontrol et
        let device_config = match self.device_configs.get(&dev_eui) {
            Some(cfg) => cfg.clone(),
            None => {
                self.stats.unknown_devices += 1;

                // Rate limiting: Bilinmeyen DevEUI'den tekrarlayan join-request'leri sinirla
                let dev_eui_hex = format!("{}", dev_eui);
                let now = Instant::now();
                let ban_duration = std::time::Duration::from_secs(300); // 5 dakika
                let max_requests: u32 = 10;

                let entry = self
                    .unknown_device_tracker
                    .entry(dev_eui_hex.clone())
                    .or_insert((0, now));

                // Ban suresi dolduysa sayaci sifirla
                if now.duration_since(entry.1) >= ban_duration {
                    *entry = (0, now);
                }

                entry.0 += 1;

                if entry.0 > max_requests {
                    warn!(
                        "Rate limit: Bilinmeyen cihaz banlandi (5dk): dev_eui={}, istek_sayisi={}",
                        dev_eui, entry.0
                    );
                    return vec![];
                }

                warn!("Bilinmeyen cihazdan join-request: dev_eui={}", dev_eui);
                return vec![MacEvent::UnknownDevice {
                    dev_eui: Some(dev_eui),
                    dev_addr: None,
                }];
            }
        };

        // DevNonce replay koruması — MIC dogrulamasindan ONCE kontrol edilir
        // Ayni DevNonce ile tekrar join-request gonderilmesini engeller (LoRaWAN 1.0.x Spec 6.2.4)
        match self.sessions.is_dev_nonce_used(&dev_eui, &dev_nonce) {
            Ok(true) => {
                warn!(
                    "DevNonce replay tespit edildi: dev_eui={}, nonce={:02X}{:02X}",
                    dev_eui, dev_nonce[0], dev_nonce[1]
                );
                return vec![];
            }
            Ok(false) => { /* Nonce kullanilmamis, devam et */ }
            Err(e) => {
                error!("DevNonce kontrol hatasi: dev_eui={}, hata={}", dev_eui, e);
                return vec![];
            }
        }

        // MIC dogrulamasi — AppKey ile
        // MIC = aes128_cmac(AppKey, MHDR | AppEUI | DevEUI | DevNonce)[0:4]
        // Join-Request icin B0 blogu kullanilmaz; MIC direkt mesaj uzerinden hesaplanir
        let mic_input = &pkt.payload[..19]; // MHDR + AppEUI + DevEUI + DevNonce
        let received_mic = &pkt.payload[19..23];

        // Join-Request MIC hesaplamasi: CMAC direkt mesaj uzerinden (B0 yok)
        // SAFETY: app_key.0 is [u8; 16] — CMAC key length always matches AES-128.
        #[allow(clippy::expect_used)]
        let mut mac =
            <cmac::Cmac<aes::Aes128> as cmac::Mac>::new_from_slice(&device_config.app_key.0)
                .expect("BUG: app_key is [u8; 16] — CMAC key length is always valid");
        cmac::Mac::update(&mut mac, mic_input);
        let cmac_result = cmac::Mac::finalize(mac).into_bytes();
        let mut computed_mic_arr = [0u8; 4];
        computed_mic_arr.copy_from_slice(&cmac_result[..4]);

        if !verify_mic(&computed_mic_arr, received_mic) {
            warn!(
                "Join-Request MIC dogrulamasi basarisiz: dev_eui={}, \
                 beklenen={:02X?}, alinan={:02X?}",
                dev_eui, computed_mic_arr, received_mic
            );
            return vec![];
        }

        debug!("Join-Request MIC dogrulandi: dev_eui={}", dev_eui);

        // Yeni DevAddr ata — NetID'nin ust 7 bitini kullanarak
        // DevAddr yapisi: NwkID(7 bit) | NwkAddr(25 bit)
        let dev_addr = self.allocate_dev_addr();

        // AppNonce (3 byte) uret — join-accept'te kullanilacak
        let app_nonce = self.generate_app_nonce();

        // Oturum anahtarlarini turet
        let session_keys = derive_session_keys(
            &device_config.app_key.0,
            &app_nonce,
            &self.net_id,
            &dev_nonce,
            dev_addr,
        );

        info!(
            "Oturum anahtarlari turetildi: dev_eui={}, dev_addr={}",
            dev_eui, dev_addr
        );

        // Oturumu veritabanina kaydet
        let codec_json = serde_json::to_string(&device_config.codec).unwrap_or_default();
        let stored = super::session::StoredSession {
            dev_eui,
            keys: session_keys.clone(),
            device_class: device_config.device_class,
            last_seen: chrono::Utc::now().timestamp(),
            rx1_delay_secs: device_config
                .rx1_delay_secs
                .unwrap_or(self.rx1_delay as u32),
            rx2_datarate: device_config.rx2_datarate.unwrap_or(0),
            rx2_freq_hz: device_config.rx2_freq_hz.unwrap_or(self.default_rx2_freq()),
            tag_prefix: device_config.tag_prefix.clone(),
            codec_json,
        };

        if let Err(e) = self.sessions.save_session(&stored) {
            error!("Oturum kaydedilemedi: dev_eui={}, hata={}", dev_eui, e);
            return vec![];
        }

        // Kullanilan DevNonce'u kaydet (replay koruması)
        // Kayit basarisiz olursa join-accept gonderilmez — aksi halde ayni DevNonce
        // ile tekrar join-request geldiginde replay attack mumkun olur
        if let Err(e) = self.sessions.save_used_dev_nonce(&dev_eui, &dev_nonce) {
            error!(
                "DevNonce kaydedilemedi, join-accept iptal: dev_eui={}, hata={}",
                dev_eui, e
            );
            return vec![];
        }

        // Aktif oturum sayisini guncelle
        if let Ok(count) = self.sessions.count_active() {
            self.stats.active_sessions = count;
        }

        // Join-Accept paketi olustur
        // Join-Accept yapisi: MHDR(1) | [AppNonce(3) | NetID(3) | DevAddr(4) | DLSettings(1) | RxDelay(1) | CFList(16)?] | MIC(4)
        // Sifreli kisim: AppNonce'dan itibaren (MHDR haric)
        let join_accept_packet =
            self.build_join_accept(&device_config.app_key.0, &app_nonce, &dev_addr, pkt);

        match join_accept_packet {
            Some(tx_packet) => {
                // Join accept butcesini dusur
                self.join_accept_budget = self.join_accept_budget.saturating_sub(1);
                info!(
                    "Join-Accept hazirlandi: dev_eui={}, dev_addr={}, RX1 zamanlamasi={}us, \
                     kalan butce={}/sn",
                    dev_eui, dev_addr, tx_packet.timestamp, self.join_accept_budget
                );
                vec![MacEvent::SendJoinAccept {
                    tx_packet,
                    dev_eui,
                    dev_addr,
                }]
            }
            None => {
                error!("Join-Accept paketi olusturulamadi: dev_eui={}", dev_eui);
                vec![]
            }
        }
    }

    /// Join-Accept TX paketi olusturur
    ///
    /// # Join-Accept Plaintext Yapisi
    /// ```text
    /// AppNonce(3) | NetID(3) | DevAddr(4) | DLSettings(1) | RxDelay(1) [| CFList(16)]
    /// ```
    /// Toplam: 12 veya 28 byte (CFList opsiyonel)
    ///
    /// # Sifreleme
    /// Join-accept ozel AES-ECB decrypt ile sifrelenir (LoRaWAN spec).
    /// MIC, sifrelenmeden once plaintext uzerinden hesaplanir.
    fn build_join_accept(
        &self,
        app_key: &[u8; 16],
        app_nonce: &[u8; 3],
        dev_addr: &DevAddr,
        rx_pkt: &RxPacket,
    ) -> Option<TxPacket> {
        // Join-Accept MHDR: MType=001 (Join-Accept), Major=00
        let mhdr: u8 = 0x20;

        // DLSettings: RX1DRoffset(3 bit) | RX2DataRate(4 bit)
        let dl_settings: u8 = 0x00; // RX1DRoffset=0, RX2DR=0

        // RxDelay: RX1 gecikme suresi (saniye), 0 = 1 saniye
        let rx_delay: u8 = if self.rx1_delay <= 1 {
            0
        } else {
            self.rx1_delay
        };

        // Join-Accept plaintext olustur (MHDR haric, cunku MHDR sifrelenmez)
        let mut plaintext = Vec::with_capacity(12);
        plaintext.extend_from_slice(app_nonce); // AppNonce (3 byte)
        plaintext.extend_from_slice(&self.net_id); // NetID (3 byte)
        plaintext.extend_from_slice(&dev_addr.0); // DevAddr (4 byte, little-endian)
        plaintext.push(dl_settings); // DLSettings (1 byte)
        plaintext.push(rx_delay); // RxDelay (1 byte)

        // MIC hesapla: aes128_cmac(AppKey, MHDR | plaintext)[0:4]
        let mut mic_input = vec![mhdr];
        mic_input.extend_from_slice(&plaintext);

        // SAFETY: app_key is &[u8; 16] — CMAC key length always matches AES-128.
        #[allow(clippy::expect_used)]
        let mut mac = <cmac::Cmac<aes::Aes128> as cmac::Mac>::new_from_slice(app_key)
            .expect("BUG: app_key is [u8; 16] — CMAC key length is always valid");
        cmac::Mac::update(&mut mac, &mic_input);
        let cmac_result = cmac::Mac::finalize(mac).into_bytes();
        let mic = &cmac_result[..4];

        // Plaintext + MIC birlestir (sifreleme icin)
        plaintext.extend_from_slice(mic);

        // Sifrele (AES-ECB decrypt = LoRaWAN join-accept sifreleme)
        let encrypted = encrypt_join_accept(app_key, &plaintext);

        // Tam PHYPayload: MHDR | sifreli kisim
        let mut phy_payload = vec![mhdr];
        phy_payload.extend_from_slice(&encrypted);

        // TX zamanlamasi: RX1 penceresi = uplink timestamp + JOIN_ACCEPT_DELAY1 (5 saniye)
        // LoRaWAN spec: Join-Accept RX1 gecikmesi 5 saniye (normal uplink'ten farkli)
        let join_accept_delay1_us: u32 = 5_000_000; // 5 saniye mikrosaniye
        let tx_timestamp = rx_pkt.timestamp.wrapping_add(join_accept_delay1_us);

        Some(TxPacket {
            payload: phy_payload,
            freq_hz: rx_pkt.freq_hz, // Ayni frekansta yanit ver (RX1)
            datarate: rx_pkt.datarate,
            bandwidth: rx_pkt.bandwidth,
            tx_power: self.default_tx_power(),
            timestamp: tx_timestamp,
            immediate: false,
        })
    }

    // ========================================================================
    // Data Uplink Isleme
    // ========================================================================

    /// Data uplink paketini isler (Unconfirmed veya Confirmed)
    ///
    /// # Data Uplink PHYPayload Yapisi
    /// ```text
    /// MHDR(1) | DevAddr(4) | FCtrl(1) | FCnt(2) | FOpts(0-15) | FPort(0-1) | FRMPayload(N) | MIC(4)
    /// ```
    ///
    /// # Islem Adimlari
    /// 1. DevAddr'i parse et ve oturum ara
    /// 2. MIC dogrulama (NwkSKey ile)
    /// 3. Frame counter kontrolu (replay koruması)
    /// 4. FRMPayload sifresini coz (AppSKey ile)
    /// 5. Codec ile sensor degerlerine donustur
    /// 6. Bekleyen downlink varsa hazirla
    fn handle_data_uplink(&mut self, pkt: &RxPacket, confirmed: bool) -> Vec<MacEvent> {
        let payload = &pkt.payload;

        // Minimum uzunluk: MHDR(1) + DevAddr(4) + FCtrl(1) + FCnt(2) + MIC(4) = 12
        if payload.len() < 12 {
            warn!("Cok kisa data uplink: {} byte (minimum 12)", payload.len());
            return vec![];
        }

        // DevAddr parse et (byte 1-4, little-endian olarak LoRaWAN'da aktarilir)
        let dev_addr = DevAddr([payload[1], payload[2], payload[3], payload[4]]);

        // FCtrl parse et
        let f_ctrl = payload[5];
        let f_opts_len = (f_ctrl & 0x0F) as usize; // Alt 4 bit = FOpts uzunlugu

        // FCnt parse et (2 byte, little-endian) — 16-bit deger alinir
        let f_cnt_16 = u16::from_le_bytes([payload[6], payload[7]]) as u32;

        // Oturumu DevAddr ile ara
        let session = match self.sessions.get_session(&dev_addr) {
            Ok(Some(s)) => s,
            Ok(None) => {
                self.stats.unknown_devices += 1;
                debug!("Bilinmeyen DevAddr: {}", dev_addr);
                return vec![MacEvent::UnknownDevice {
                    dev_eui: None,
                    dev_addr: Some(dev_addr),
                }];
            }
            Err(e) => {
                error!("Oturum sorgusu hatasi: dev_addr={}, hata={}", dev_addr, e);
                return vec![];
            }
        };

        // FCnt 16-bit -> 32-bit genisletme (LoRaWAN 1.0.x Spec)
        // Ust 16 bit oturumdaki son bilinen f_cnt_up'tan alinir.
        // Eger hesaplanan 32-bit deger son bilinen degerden kucukse,
        // MSB bir arttirilir (16-bit rollover durumu).
        let f_cnt_msb = session.keys.f_cnt_up & 0xFFFF0000;
        let mut f_cnt = f_cnt_msb | f_cnt_16;
        if f_cnt < session.keys.f_cnt_up {
            f_cnt = (f_cnt_msb.wrapping_add(0x10000)) | f_cnt_16;
        }

        // Ucuz, OTORİTE-OLMAYAN erken reddetme (EDGE-HIGH-017): reconstrue
        // edilen f_cnt beklenen sonraki sayactan (f_cnt_up) kucukse bariz bir
        // replay'dir — MIC hesaplamadan reddet. Otorite kapisi asagida,
        // MIC dogrulamasindan SONRA gelen atomik check_and_advance'tir.
        if f_cnt < session.keys.f_cnt_up {
            self.stats.replay_rejects += 1;
            warn!(
                "Replay korumasi (erken): paket reddedildi, dev_addr={}, beklenen_f_cnt={}, gelen_f_cnt={}",
                dev_addr, session.keys.f_cnt_up, f_cnt
            );
            return vec![];
        }

        // MIC dogrulama — NwkSKey ile
        // MIC = aes128_cmac(NwkSKey, B0 | MHDR | MACPayload)[0:4]
        let msg_len = (payload.len() - 4) as u8; // MIC haric uzunluk
        let b0 = build_b0(0, &dev_addr, f_cnt, msg_len);
        let computed_mic = compute_mic(&session.keys.nwk_s_key, &b0, &payload[..payload.len() - 4]);
        let received_mic = &payload[payload.len() - 4..];

        if !verify_mic(&computed_mic, received_mic) {
            warn!(
                "Data uplink MIC dogrulamasi basarisiz: dev_addr={}, f_cnt={}, \
                 beklenen={:02X?}, alinan={:02X?}",
                dev_addr, f_cnt, computed_mic, received_mic
            );
            return vec![];
        }

        // OTORİTE replay kapisi (EDGE-HIGH-017): MIC dogrulandiktan SONRA
        // (boylece sahte yuksek-f_cnt bir cerceve sayaci ilerletip cihazi
        // DoS edemez) ve herhangi bir olay uretilmeden ÖNCE, sayaci atomik
        // olarak dogrula-ve-ilerlet. Yaziya-gecirme (write-through) tek
        // dayanikli islemdir; oku-stale/yaz-elsewhere penceresi yoktur.
        match self
            .sessions
            .check_and_advance_f_cnt_up(&session.dev_eui, f_cnt)
        {
            Ok(true) => {
                // Taze — devam et.
            }
            Ok(false) => {
                // Replay / bayat — hicbir satir ilerletilmedi.
                self.stats.replay_rejects += 1;
                warn!(
                    "Replay korumasi (otorite): paket reddedildi, dev_addr={}, gelen_f_cnt={}",
                    dev_addr, f_cnt
                );
                return vec![];
            }
            Err(e) => {
                // Sayac kalici olarak yazilamadi — FAIL-CLOSED: kabul etme.
                // Aksi halde cokme sonrasi replay penceresi acilirdi.
                error!(
                    "Frame counter ilerletilemedi (fail-closed reddet): dev_eui={}, hata={}",
                    session.dev_eui, e
                );
                return vec![];
            }
        }

        let mut events = Vec::new();

        // FRMPayload'i cikart ve sifresini coz
        // FOpts'tan sonra FPort(1 byte), ardindan FRMPayload gelir
        let f_port_offset = 8 + f_opts_len; // MHDR(1) + DevAddr(4) + FCtrl(1) + FCnt(2) + FOpts

        if f_port_offset >= payload.len() - 4 {
            // FPort ve FRMPayload yok — sadece MAC komutlari iceren paket
            debug!(
                "MAC-only uplink: dev_addr={}, f_cnt={}, f_opts_len={}",
                dev_addr, f_cnt, f_opts_len
            );
            self.stats.uplinks_processed += 1;
            return events;
        }

        let f_port = payload[f_port_offset];
        let frm_payload_start = f_port_offset + 1;
        let frm_payload_end = payload.len() - 4; // MIC haric

        let encrypted_payload = if frm_payload_start < frm_payload_end {
            &payload[frm_payload_start..frm_payload_end]
        } else {
            &[] as &[u8]
        };

        // Payload sifresini coz
        // FPort == 0 ise NwkSKey ile (MAC komutlari), degilse AppSKey ile (uygulama verisi)
        let decryption_key = if f_port == 0 {
            &session.keys.nwk_s_key
        } else {
            &session.keys.app_s_key
        };

        let decrypted = encrypt_frm_payload(
            decryption_key,
            &dev_addr,
            0, // dir = 0 (uplink)
            f_cnt,
            encrypted_payload,
        );

        // Codec ile payload'i decode et
        let decoded_values = if f_port > 0 && !decrypted.is_empty() {
            // Cihaz konfigurasyonundan codec turunu al
            if let Some(device_cfg) = self.device_configs.get(&session.dev_eui) {
                decode_payload(&decrypted, &device_cfg.tag_prefix, &device_cfg.codec)
            } else {
                // Cihaz config'i bulunamadi — codec bilgisi oturumda JSON olarak sakli
                // Fallback: oturumdaki codec_json'i kullan
                match serde_json::from_str::<super::types::CodecType>(&session.codec_json) {
                    Ok(codec) => decode_payload(&decrypted, &session.tag_prefix, &codec),
                    Err(e) => {
                        warn!(
                            "Codec JSON parse hatasi: dev_eui={}, hata={}",
                            session.dev_eui, e
                        );
                        vec![]
                    }
                }
            }
        } else {
            vec![]
        };

        if !decoded_values.is_empty() {
            debug!(
                "Uplink decode basarili: dev_eui={}, f_port={}, {} deger: {:?}",
                session.dev_eui,
                f_port,
                decoded_values.len(),
                decoded_values
            );
        }

        self.stats.uplinks_processed += 1;

        // Uplink data event'i olustur
        events.push(MacEvent::UplinkData {
            dev_eui: session.dev_eui,
            dev_addr,
            f_port,
            payload: decrypted,
            f_cnt,
            rssi: pkt.rssi,
            snr: pkt.snr,
            decoded_values,
        });

        // Bekleyen downlink varsa hazirla (confirmed uplink ise ACK gonder)
        if let Some(downlink_event) = self.prepare_downlink(&dev_addr, &session, pkt, confirmed) {
            events.push(downlink_event);
        }

        events
    }

    // ========================================================================
    // Downlink Hazirlama
    // ========================================================================

    /// Bekleyen downlink'i TX paketi olarak hazirlar
    ///
    /// Class A cihazlara sadece uplink sonrasinda gonderilebilir.
    /// Kuyruktan en yuksek oncelikli mesaji alir ve sifreler.
    fn prepare_downlink(
        &mut self,
        dev_addr: &DevAddr,
        session: &super::session::StoredSession,
        rx_pkt: &RxPacket,
        ack_requested: bool,
    ) -> Option<MacEvent> {
        // Bu DevAddr icin bekleyen downlink var mi? (FIFO; TTL suresi dolmus
        // girisler alma aninda budanir — bayat downlink asla gonderilmez.)
        let downlink = match self.downlink_queue.take_for_dev_addr(dev_addr) {
            Some(item) => item,
            None => {
                // Kuyrukta downlink yok — eger confirmed uplink ise bos ACK downlink gonder
                // LoRaWAN 1.0.x spec: confirmed uplink'e MUTLAKA ACK gonderilmeli,
                // aksi halde cihaz ayni paketi tekrar tekrar gonderir
                if ack_requested {
                    return self.prepare_empty_ack(dev_addr, session, rx_pkt);
                }
                return None;
            }
        };

        // Downlink frame counter'i al
        let f_cnt_down = match self.sessions.increment_f_cnt_down(&session.dev_eui) {
            Ok(cnt) => cnt,
            Err(e) => {
                error!(
                    "FCntDown artirilamadi: dev_eui={}, hata={}",
                    session.dev_eui, e
                );
                return None;
            }
        };

        // FRMPayload sifrele (AppSKey ile)
        let encrypted = encrypt_frm_payload(
            &session.keys.app_s_key,
            dev_addr,
            1, // dir = 1 (downlink)
            f_cnt_down,
            &downlink.payload,
        );

        // Downlink PHYPayload olustur
        // MHDR: Unconfirmed Data Down = 0x60, Confirmed Data Down = 0xA0
        let mhdr: u8 = if downlink.confirmed { 0xA0 } else { 0x60 };

        // FCtrl: Confirmed uplink'e cevap verirken ACK bitini set et (bit 5 = 0x20)
        let f_ctrl: u8 = if ack_requested { 0x20 } else { 0x00 };

        let mut phy_payload = Vec::new();
        phy_payload.push(mhdr); // MHDR
        phy_payload.extend_from_slice(&dev_addr.0); // DevAddr (4 byte)
        phy_payload.push(f_ctrl); // FCtrl (ACK bit set edilir eger confirmed uplink ise)
        phy_payload.extend_from_slice(&(f_cnt_down as u16).to_le_bytes()); // FCnt (2 byte)
        phy_payload.push(downlink.f_port); // FPort
        phy_payload.extend_from_slice(&encrypted); // FRMPayload (sifreli)

        // MIC hesapla (NwkSKey ile)
        let msg_len = phy_payload.len() as u8;
        let b0 = build_b0(1, dev_addr, f_cnt_down, msg_len);
        let mic = compute_mic(&session.keys.nwk_s_key, &b0, &phy_payload);
        phy_payload.extend_from_slice(&mic);

        // TX zamanlamasi: RX1 penceresi = uplink timestamp + RX1_DELAY
        let rx1_delay_us = (session.rx1_delay_secs as u32) * 1_000_000;
        let tx_timestamp = rx_pkt.timestamp.wrapping_add(rx1_delay_us);

        self.stats.packets_sent += 1;

        Some(MacEvent::SendDownlink {
            tx_packet: TxPacket {
                payload: phy_payload,
                freq_hz: rx_pkt.freq_hz, // RX1: ayni frekans
                datarate: rx_pkt.datarate,
                bandwidth: rx_pkt.bandwidth,
                tx_power: self.default_tx_power(),
                timestamp: tx_timestamp,
                immediate: false,
            },
        })
    }

    /// Confirmed uplink'e bos ACK downlink olusturur (kuyrukta bekleyen downlink yokken)
    ///
    /// LoRaWAN 1.0.x: Confirmed uplink alan gateway MUTLAKA ACK gondermelidir.
    /// Kuyrukta downlink yoksa bile, bos bir frame (FPort yok, FRMPayload yok) ile
    /// ACK bit'i set edilmis downlink gonderilir.
    fn prepare_empty_ack(
        &mut self,
        dev_addr: &DevAddr,
        session: &super::session::StoredSession,
        rx_pkt: &RxPacket,
    ) -> Option<MacEvent> {
        // Downlink frame counter'i al
        let f_cnt_down = match self.sessions.increment_f_cnt_down(&session.dev_eui) {
            Ok(cnt) => cnt,
            Err(e) => {
                error!(
                    "FCntDown artirilamadi (empty ACK): dev_eui={}, hata={}",
                    session.dev_eui, e
                );
                return None;
            }
        };

        // Bos ACK downlink: Unconfirmed Data Down (0x60) + ACK bit (0x20)
        let mhdr: u8 = 0x60;
        let f_ctrl: u8 = 0x20; // ACK bit set, FOptsLen = 0

        let mut phy_payload = Vec::new();
        phy_payload.push(mhdr);
        phy_payload.extend_from_slice(&dev_addr.0);
        phy_payload.push(f_ctrl);
        phy_payload.extend_from_slice(&(f_cnt_down as u16).to_le_bytes());
        // FPort ve FRMPayload yok — bos frame

        // MIC hesapla (NwkSKey ile)
        let msg_len = phy_payload.len() as u8;
        let b0 = build_b0(1, dev_addr, f_cnt_down, msg_len); // dir=1 (downlink)
        let mic = compute_mic(&session.keys.nwk_s_key, &b0, &phy_payload);
        phy_payload.extend_from_slice(&mic);

        // RX1 window zamanlama
        let rx1_delay_us = (session.rx1_delay_secs.max(1) as u32) * 1_000_000;
        let tx_timestamp = rx_pkt.timestamp.wrapping_add(rx1_delay_us);

        self.stats.packets_sent += 1;

        Some(MacEvent::SendDownlink {
            tx_packet: TxPacket {
                payload: phy_payload,
                freq_hz: rx_pkt.freq_hz,
                datarate: rx_pkt.datarate,
                bandwidth: rx_pkt.bandwidth,
                tx_power: self.default_tx_power(),
                timestamp: tx_timestamp,
                immediate: false,
            },
        })
    }

    // ========================================================================
    // Yardimci Fonksiyonlar
    // ========================================================================

    /// Yeni DevAddr atar
    ///
    /// Basit artimli atama: NetID prefix + artan sayac
    /// Uretim ortaminda daha karmasik bir atama algoritmasi kullanilabilir
    fn allocate_dev_addr(&mut self) -> DevAddr {
        // NetID'den NwkID al (ust 7 bit)
        let nwk_id = self.net_id[2] & 0x7F; // Son byte'in alt 7 bit'i
        let nwk_addr = self.next_dev_addr_counter & 0x01FF_FFFF; // 25-bit ag adresi

        // DevAddr = NwkID(7 bit) | NwkAddr(25 bit)
        let dev_addr_u32 = ((nwk_id as u32) << 25) | nwk_addr;
        self.next_dev_addr_counter = self.next_dev_addr_counter.wrapping_add(1);

        DevAddr::from_u32(dev_addr_u32)
    }

    /// 3-byte AppNonce uretir (basit, zaman tabanli)
    ///
    /// Gercek uretim ortaminda kriptografik PRNG kullanilmalidir
    fn generate_app_nonce(&self) -> [u8; 3] {
        let now = chrono::Utc::now().timestamp_millis() as u32;
        [
            (now & 0xFF) as u8,
            ((now >> 8) & 0xFF) as u8,
            ((now >> 16) & 0xFF) as u8,
        ]
    }

    /// Bolgeye gore varsayilan TX gucu dondurur (dBm)
    fn default_tx_power(&self) -> i8 {
        match self.region {
            LoRaRegion::Eu868 => 14, // ERP 25mW = 14 dBm
            LoRaRegion::Us915 => 20, // 100mW = 20 dBm
            LoRaRegion::Au915 => 20,
            LoRaRegion::As923 => 14,
            LoRaRegion::Cn470 => 19,
            LoRaRegion::Kr920 => 14,
            LoRaRegion::In865 => 27,
        }
    }

    /// Bolgeye gore varsayilan RX2 frekansini dondurur (Hz)
    fn default_rx2_freq(&self) -> u32 {
        match self.region {
            LoRaRegion::Eu868 => 869_525_000,
            LoRaRegion::Us915 => 923_300_000,
            LoRaRegion::Au915 => 923_300_000,
            LoRaRegion::As923 => 923_200_000,
            LoRaRegion::Cn470 => 505_300_000,
            LoRaRegion::Kr920 => 921_900_000,
            LoRaRegion::In865 => 866_550_000,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // 2026-04-30: Curated feature CI compiles LoRa MAC tests with the
    // protocol-only `lorawan` feature. Keep test fixtures explicit about every
    // LoRaWAN key newtype they construct instead of relying on parent-module
    // incidental imports.
    use crate::lora::types::{ActivationMode, AppEui, AppKey, CodecType, DeviceClass};

    fn make_test_mac() -> LoRaMac {
        let sessions = SessionStore::in_memory().expect("test session store");
        LoRaMac::new(LoRaRegion::Eu868, [0x00, 0x00, 0x01], sessions, 1)
    }

    fn make_test_device_config() -> LoRaDeviceConfig {
        LoRaDeviceConfig {
            dev_eui: DevEui([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]),
            app_eui: AppEui([0x00; 8]),
            app_key: AppKey([
                0x2B, 0x7E, 0x15, 0x16, 0x28, 0xAE, 0xD2, 0xA6, 0xAB, 0xF7, 0x15, 0x88, 0x09, 0xCF,
                0x4F, 0x3C,
            ]),
            activation: ActivationMode::Otaa,
            device_class: DeviceClass::A,
            tag_prefix: "lora_test_".to_string(),
            codec: CodecType::CayenneLpp,
            rx1_delay_secs: None,
            rx2_datarate: None,
            rx2_freq_hz: None,
            adr_enabled: false,
        }
    }

    #[test]
    fn test_mac_add_remove_device() {
        let mut mac = make_test_mac();
        let config = make_test_device_config();
        let dev_eui = config.dev_eui;

        assert_eq!(mac.device_count(), 0);
        mac.add_device(config);
        assert_eq!(mac.device_count(), 1);
        mac.remove_device(&dev_eui);
        assert_eq!(mac.device_count(), 0);
    }

    #[test]
    fn test_mac_queue_downlink() {
        let mut mac = make_test_mac();

        mac.queue_downlink(DownlinkItem {
            dev_addr: DevAddr([0x26, 0x01, 0x00, 0x01]),
            payload: vec![0x01, 0x02],
            f_port: 10,
            confirmed: false,
            priority: 0,
        });

        assert_eq!(mac.downlink_queue.len(), 1);
    }

    #[test]
    fn test_mac_crc_error_packet() {
        let mut mac = make_test_mac();

        let pkt = RxPacket {
            payload: vec![0x00; 23],
            freq_hz: 868_100_000,
            datarate: 7,
            bandwidth: 125_000,
            rssi: -50,
            snr: 10.0,
            timestamp: 1000,
            crc_ok: false, // CRC hatali
        };

        let events = mac.process_uplink(&pkt);
        assert!(events.is_empty());
        assert_eq!(mac.stats.crc_errors, 1);
    }

    #[test]
    fn test_mac_short_packet() {
        let mut mac = make_test_mac();

        let pkt = RxPacket {
            payload: vec![0x00, 0x01, 0x02], // 3 byte — cok kisa
            freq_hz: 868_100_000,
            datarate: 7,
            bandwidth: 125_000,
            rssi: -50,
            snr: 10.0,
            timestamp: 1000,
            crc_ok: true,
        };

        let events = mac.process_uplink(&pkt);
        assert!(events.is_empty());
    }

    #[test]
    fn test_mac_unknown_device_join() {
        let mut mac = make_test_mac();

        // Kayitli olmayan cihazdan join-request (23 byte)
        let pkt = RxPacket {
            payload: vec![0x00; 23], // MType=0 (join-request), hepsi sifir
            freq_hz: 868_100_000,
            datarate: 7,
            bandwidth: 125_000,
            rssi: -80,
            snr: 5.0,
            timestamp: 1000,
            crc_ok: true,
        };

        let events = mac.process_uplink(&pkt);
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], MacEvent::UnknownDevice { .. }));
        assert_eq!(mac.stats.unknown_devices, 1);
    }

    #[test]
    fn test_allocate_dev_addr() {
        let mut mac = make_test_mac();
        let addr1 = mac.allocate_dev_addr();
        let addr2 = mac.allocate_dev_addr();

        // Her atama farkli olmali
        assert_ne!(addr1, addr2);
    }

    #[test]
    fn test_default_tx_power() {
        let mac = make_test_mac();
        assert_eq!(mac.default_tx_power(), 14); // EU868 = 14 dBm
    }

    #[test]
    fn test_default_rx2_freq() {
        let mac = make_test_mac();
        assert_eq!(mac.default_rx2_freq(), 869_525_000); // EU868 RX2
    }

    #[test]
    fn test_stats_initial() {
        let mac = make_test_mac();
        let stats = mac.stats_snapshot();
        assert_eq!(stats.packets_received, 0);
        assert_eq!(stats.uplinks_processed, 0);
        assert_eq!(stats.crc_errors, 0);
        assert_eq!(stats.unknown_devices, 0);
    }
}
