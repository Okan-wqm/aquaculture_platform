//! LoRaWAN 1.0.x Gateway Modulu
//!
//! SX1302 tabanli LoRa gateway entegrasyonu icin tam altyapi.
//! Actor pattern ile thread-safe erisim saglar (spi.rs ile ayni desen).
//!
//! # Modul Yapisi
//! - `types`: Paylasilam veri yapilari (DevEui, SessionKeys, config vs.)
//! - `crypto`: LoRaWAN 1.0.x kriptografi (MIC, payload sifreleme, anahtar turetme)
//! - `codec`: Payload decoder'lar (Cayenne LPP, Raw Binary, Custom)
//! - `session`: SQLite tabanli oturum deposu (anahtar ve frame sayaci persistance)
//! - `sx1302`: SX1302 konsantrator HAL wrapper (FFI + simulasyon)
//! - `mac`: LoRaWAN MAC durum makinesi (join, uplink, downlink)
//!
//! # Actor Deseni
//! LoRaHandle, actor pattern ile SX1302 donanimina ve MAC katmanina
//! thread-safe erisim saglar. Tum islemler mpsc kanali uzerinden
//! actor task'ina gonderilir, sonuclar oneshot ile dondurulur.
//!
//! ```text
//! LoRaHandle (Clone, Send)
//!     |  mpsc::Sender<LoRaCommand>
//!     v
//! LoRaActor (spawned task)
//!     |-- Sx1302 (radio HAL)
//!     |-- LoRaMac (MAC state machine)
//!     |-- ProcessImage ref
//!     |-- MqttClient ref
//! ```

pub mod codec;
pub mod crypto;
pub mod downlink_queue;
pub mod mac;
pub mod session;
pub mod sx1302;
pub mod types;

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::sync::{RwLock, mpsc, oneshot};
use tracing::{debug, error, info, warn};

use crate::AppState;
use crate::config::LoRaWanConfig;
use crate::io_poll::{IoDataPayload, IoTagData};
use crate::process_image::{TagQuality, TagSource};

use self::downlink_queue::EnqueueOutcome;
use self::mac::{DownlinkItem, LoRaMac, MacEvent};
use self::session::SessionStore;
use self::sx1302::Sx1302;
use self::types::{DevEui, LoRaDeviceConfig, LoRaRegion, LoRaStats};

// ============================================================================
// Actor Komutlari
// ============================================================================

/// LoRa actor'une gonderilen komutlar
///
/// Her komut bir oneshot kanal ile cevap bekler (SpiCommand ile ayni desen).
/// Shutdown haricinde tum komutlar sonuc dondurur.
#[derive(Debug)]
pub enum LoRaCommand {
    /// SX1302'yi baslat ve MAC'i yapilandir
    Init {
        response: oneshot::Sender<Result<()>>,
    },

    /// Yeni LoRa cihazi ekle
    AddDevice {
        config: LoRaDeviceConfig,
        response: oneshot::Sender<Result<()>>,
    },

    /// LoRa cihazi kaldir
    RemoveDevice {
        dev_eui: DevEui,
        response: oneshot::Sender<Result<()>>,
    },

    /// Downlink mesaji kuyruga ekle
    QueueDownlink {
        item: DownlinkItem,
        response: oneshot::Sender<Result<()>>,
    },

    /// Istatistikleri al
    GetStats {
        response: oneshot::Sender<LoRaStats>,
    },

    /// Actor'u durdur
    Shutdown,
}

/// Actor kanal buffer boyutu
const LORA_CHANNEL_SIZE: usize = 64;

/// Radio polling araligi (milisaniye) — SX1302 FIFO okuma periyodu
const RADIO_POLL_INTERVAL_MS: u64 = 10;

// ============================================================================
// LoRaHandle — Public API (Clone, Send)
// ============================================================================

/// Thread-safe handle — LoRa actor ile iletisim saglar
///
/// SpiHandle ile ayni desen: mpsc kanali uzerinden komut gondermek,
/// oneshot kanali ile sonuc almak.
#[derive(Clone)]
pub struct LoRaHandle {
    sender: mpsc::Sender<LoRaCommand>,
}

impl LoRaHandle {
    /// Yeni LoRa actor'unu olusturur ve spawn eder
    ///
    /// # Parametreler
    /// - `lora_cfg`: LoRaWAN yapilandirmasi (config.yaml'dan)
    /// - `state`: Paylasilam uygulama durumu (ProcessImage + MQTT erisimi icin)
    pub fn new(lora_cfg: &LoRaWanConfig, state: Arc<RwLock<AppState>>) -> Self {
        let (sender, receiver) = mpsc::channel(LORA_CHANNEL_SIZE);

        let config = lora_cfg.clone();
        tokio::spawn(async move {
            let mut actor = LoRaActor::new(config, receiver, state);
            actor.run().await;
        });

        Self { sender }
    }

    /// SX1302'yi baslat
    pub async fn init(&self) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.send_command(LoRaCommand::Init { response: tx })
            .await?;
        rx.await
            .map_err(|_| anyhow::anyhow!("LoRa actor disconnected"))?
    }

    /// Cihaz ekle
    pub async fn add_device(&self, config: LoRaDeviceConfig) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.send_command(LoRaCommand::AddDevice {
            config,
            response: tx,
        })
        .await?;
        rx.await
            .map_err(|_| anyhow::anyhow!("LoRa actor disconnected"))?
    }

    /// Cihaz kaldir
    pub async fn remove_device(&self, dev_eui: DevEui) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.send_command(LoRaCommand::RemoveDevice {
            dev_eui,
            response: tx,
        })
        .await?;
        rx.await
            .map_err(|_| anyhow::anyhow!("LoRa actor disconnected"))?
    }

    /// Downlink mesaji kuyruga ekle
    pub async fn queue_downlink(&self, item: DownlinkItem) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.send_command(LoRaCommand::QueueDownlink { item, response: tx })
            .await?;
        rx.await
            .map_err(|_| anyhow::anyhow!("LoRa actor disconnected"))?
    }

    /// Istatistikleri al
    pub async fn get_stats(&self) -> Result<LoRaStats> {
        let (tx, rx) = oneshot::channel();
        self.send_command(LoRaCommand::GetStats { response: tx })
            .await?;
        rx.await
            .map_err(|_| anyhow::anyhow!("LoRa actor disconnected"))
    }

    /// Actor'u durdur
    pub async fn shutdown(&self) {
        let _ = self.sender.send(LoRaCommand::Shutdown).await;
    }

    /// Komutu actor'e gonder
    async fn send_command(&self, cmd: LoRaCommand) -> Result<()> {
        self.sender
            .send(cmd)
            .await
            .map_err(|_| anyhow::anyhow!("LoRa actor disconnected"))
    }
}

// ============================================================================
// LoRaActor — Dahili Actor Implementasyonu
// ============================================================================

/// LoRa actor — SX1302 ve MAC katmanini yonetir
///
/// `tokio::select!` ile ayni anda:
/// 1. Radio'dan paket polling (her 10ms)
/// 2. Komut kanali dinleme
struct LoRaActor {
    /// LoRaWAN yapilandirmasi
    config: LoRaWanConfig,
    /// Komut alim kanali
    receiver: mpsc::Receiver<LoRaCommand>,
    /// SX1302 konsantrator — radio donanimi
    sx1302: Option<Sx1302>,
    /// MAC durum makinesi — join/uplink/downlink isleme
    mac: Option<LoRaMac>,
    /// Paylasilam uygulama durumu — ProcessImage + MQTT
    state: Arc<RwLock<AppState>>,
    /// Bekleyen io_data toplama tamponu — 100ms penceresi ile batch publish
    /// Her uplink'ten gelen (tag_name, value, quality) biriktirilir,
    /// 100ms interval ile topluca MQTT'ye yayinlanir
    pending_io_data: Vec<(String, f64, TagQuality)>,
}

impl LoRaActor {
    fn new(
        config: LoRaWanConfig,
        receiver: mpsc::Receiver<LoRaCommand>,
        state: Arc<RwLock<AppState>>,
    ) -> Self {
        Self {
            config,
            receiver,
            sx1302: None,
            mac: None,
            state,
            pending_io_data: Vec::new(),
        }
    }

    /// Actor ana dongusu
    ///
    /// `tokio::select!` ile esanli radio polling ve komut isleme yapilir.
    /// Radio polling araligi 10ms — SX1302 FIFO'sundan paketleri okur.
    async fn run(&mut self) {
        info!("LoRa actor baslatildi");

        let mut radio_interval =
            tokio::time::interval(tokio::time::Duration::from_millis(RADIO_POLL_INTERVAL_MS));
        radio_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        // io_data batch publish araligi — 100ms penceresi ile toplanan
        // uplink verilerini tek MQTT mesajinda gonderir
        let mut batch_interval = tokio::time::interval(tokio::time::Duration::from_millis(100));
        batch_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        // Frame counter flush araligi — bellekteki counter cache'ini SQLite'a yaz
        let mut flush_interval = tokio::time::interval(tokio::time::Duration::from_secs(10));
        flush_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        // Periyodik temizlik araligi — unknown_device_tracker memory leak onleme
        let mut cleanup_interval = tokio::time::interval(tokio::time::Duration::from_secs(600)); // 10 dakika
        cleanup_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                // Radio polling — her 10ms paket kontrol et
                _ = radio_interval.tick() => {
                    if self.sx1302.is_some() && self.mac.is_some() {
                        self.poll_radio().await;
                    }
                }

                // io_data batch flush — her 100ms bekleyen verileri topluca yayinla
                _ = batch_interval.tick() => {
                    if !self.pending_io_data.is_empty() {
                        self.flush_pending_io_data().await;
                    }
                }

                // Frame counter flush — bellekteki counter'lari SQLite'a batch yaz
                _ = flush_interval.tick() => {
                    if let Some(ref mac) = self.mac {
                        if let Err(e) = mac.flush_frame_counters() {
                            warn!("Frame counter flush hatasi: {}", e);
                        }
                    }
                }

                // Periyodik temizlik — suresi dolmus rate limit entry'lerini kaldir
                _ = cleanup_interval.tick() => {
                    if let Some(ref mut mac) = self.mac {
                        mac.cleanup_unknown_device_tracker();
                    }
                }

                // Komut isleme
                cmd = self.receiver.recv() => {
                    match cmd {
                        Some(LoRaCommand::Init { response }) => {
                            let result = self.handle_init().await;
                            let _ = response.send(result);
                        }
                        Some(LoRaCommand::AddDevice { config, response }) => {
                            let result = self.handle_add_device(config);
                            let _ = response.send(result);
                        }
                        Some(LoRaCommand::RemoveDevice { dev_eui, response }) => {
                            let result = self.handle_remove_device(dev_eui);
                            let _ = response.send(result);
                        }
                        Some(LoRaCommand::QueueDownlink { item, response }) => {
                            let result = self.handle_queue_downlink(item);
                            let _ = response.send(result);
                        }
                        Some(LoRaCommand::GetStats { response }) => {
                            let stats = self.handle_get_stats();
                            let _ = response.send(stats);
                        }
                        Some(LoRaCommand::Shutdown) | None => {
                            info!("LoRa actor durduruluyor");
                            // Kapanmadan once bekleyen io_data'yi flush et
                            if !self.pending_io_data.is_empty() {
                                self.flush_pending_io_data().await;
                            }
                            // Frame counter cache'ini SQLite'a yaz — veri kaybi onleme
                            if let Some(ref mac) = self.mac {
                                if let Err(e) = mac.flush_frame_counters() {
                                    warn!("Shutdown frame counter flush hatasi: {}", e);
                                } else {
                                    info!("Frame counter'lar SQLite'a flush edildi");
                                }
                            }
                            break;
                        }
                    }
                }
            }
        }

        // SX1302'yi kapat (Drop ile otomatik yapilir ama log icin burada)
        if let Some(sx) = self.sx1302.take() {
            drop(sx);
            info!("SX1302 kapatildi");
        }

        info!("LoRa actor durduruldu");
    }

    // ========================================================================
    // Komut Handler'lari
    // ========================================================================

    /// SX1302 ve MAC katmanini baslat
    async fn handle_init(&mut self) -> Result<()> {
        // Bolge konfigurasyonunu parse et
        let region = parse_region(&self.config.region)?;

        // NetID parse et (hex string, 6 karakter)
        let net_id = parse_net_id(&self.config.net_id)?;

        // SX1302 olustur ve baslat
        let reset_pin = if self.config.reset_gpio_pin > 0 {
            Some(self.config.reset_gpio_pin)
        } else {
            None
        };

        let mut sx1302 = Sx1302::new(region, reset_pin);
        sx1302.init().context("SX1302 baslatma hatasi")?;

        // Oturum deposu olustur
        let session_db_path = &self.config.session_db_path;
        let sessions = SessionStore::new(Path::new(session_db_path))
            .context("LoRa session store baslatma hatasi")?;

        // MAC olustur
        let mut mac = LoRaMac::new(region, net_id, sessions, self.config.rx1_delay);

        // Yapilandirmadaki cihazlari ekle
        for device_yaml in &self.config.devices {
            match parse_device_config(device_yaml) {
                Ok(device_config) => {
                    mac.add_device(device_config);
                }
                Err(e) => {
                    warn!("LoRa cihaz yapilandirmasi hatasi: {}", e);
                }
            }
        }

        info!(
            "LoRa baslatildi: bolge={:?}, {} cihaz kayitli",
            region,
            mac.device_count()
        );

        self.sx1302 = Some(sx1302);
        self.mac = Some(mac);

        Ok(())
    }

    fn handle_add_device(&mut self, config: LoRaDeviceConfig) -> Result<()> {
        if let Some(ref mut mac) = self.mac {
            mac.add_device(config);
            Ok(())
        } else {
            anyhow::bail!("LoRa MAC henuz baslatilmamis — once init() cagirin")
        }
    }

    fn handle_remove_device(&mut self, dev_eui: DevEui) -> Result<()> {
        if let Some(ref mut mac) = self.mac {
            mac.remove_device(&dev_eui);
            Ok(())
        } else {
            anyhow::bail!("LoRa MAC henuz baslatilmamis")
        }
    }

    fn handle_queue_downlink(&mut self, item: DownlinkItem) -> Result<()> {
        if let Some(ref mut mac) = self.mac {
            let dev_addr = item.dev_addr;
            // Reddedilme (per-DevAddr derinlik siniri dolu) cagiran tarafa
            // gorunur hata olarak yansitilir — sessizce dusurulmez. En eski
            // girisin cikarilmasi (evict-oldest) icsel geri-basincdir ve
            // cagirilan downlink kabul edildiginden Ok doner.
            match mac.queue_downlink(item) {
                EnqueueOutcome::Accepted | EnqueueOutcome::AcceptedEvictedOldest => Ok(()),
                EnqueueOutcome::RejectedDevAddrFull => {
                    anyhow::bail!(
                        "Downlink kuyruga alinamadi: dev_addr={} icin bekleyen downlink \
                         siniri dolu",
                        dev_addr
                    )
                }
            }
        } else {
            anyhow::bail!("LoRa MAC henuz baslatilmamis")
        }
    }

    fn handle_get_stats(&self) -> LoRaStats {
        self.mac
            .as_ref()
            .map(|m| m.stats_snapshot())
            .unwrap_or_default()
    }

    // ========================================================================
    // Radio Polling
    // ========================================================================

    /// SX1302'den paketleri okur ve MAC katmanina iletir
    ///
    /// Her basarili uplink sonrasi:
    /// 1. ProcessImage guncellenir (sensor degerleri)
    /// 2. MQTT uzerinden io_data yayinlanir
    /// 3. TX paketleri (join-accept, downlink) SX1302'ye gonderilir
    async fn poll_radio(&mut self) {
        let sx1302 = match self.sx1302.as_ref() {
            Some(sx) => sx,
            None => return,
        };

        // SX1302'den paketleri oku
        let packets = match sx1302.receive() {
            Ok(pkts) => pkts,
            Err(e) => {
                warn!("SX1302 paket alma hatasi: {}", e);
                return;
            }
        };

        if packets.is_empty() {
            return;
        }

        // Her paketi MAC katmaninda isle
        for pkt in &packets {
            let events = match self.mac.as_mut() {
                Some(mac) => mac.process_uplink(pkt),
                None => return,
            };

            for event in events {
                self.handle_mac_event(event).await;
            }
        }
    }

    /// MAC olayi isle
    ///
    /// - UplinkData: ProcessImage guncelle + MQTT io_data yayinla
    /// - SendJoinAccept / SendDownlink: SX1302 uzerinden gonder
    /// - FrameCounterReset: Uyari logla + MQTT event yayinla
    /// - UnknownDevice: Uyari logla
    async fn handle_mac_event(&mut self, event: MacEvent) {
        match event {
            MacEvent::UplinkData {
                dev_eui,
                dev_addr,
                f_port,
                payload: _,
                f_cnt,
                rssi,
                snr,
                decoded_values,
            } => {
                debug!(
                    "Uplink islendi: dev_eui={}, dev_addr={}, f_port={}, f_cnt={}, \
                     RSSI={} dBm, SNR={:.1} dB, {} deger",
                    dev_eui,
                    dev_addr,
                    f_port,
                    f_cnt,
                    rssi,
                    snr,
                    decoded_values.len()
                );

                if decoded_values.is_empty() {
                    return;
                }

                // RwLock'u erken birak: process_image'i clone'la, tag guncellemesi lock disinda yapilir
                let process_image = {
                    let state = self.state.read().await;
                    state.process_image.clone()
                };
                // Artik kilit yok — ProcessImage guncellemesi lock tutmadan calisir

                for (tag_name, value) in &decoded_values {
                    // ProcessImage'e yaz (lock disinda)
                    process_image
                        .update_tag(tag_name, *value, TagQuality::Good, TagSource::LoRa)
                        .await;

                    // io_data'yi batch tamponuna ekle — 100ms penceresi ile topluca yayinlanacak
                    self.pending_io_data
                        .push((tag_name.clone(), *value, TagQuality::Good));
                }

                debug!(
                    "Uplink verileri tampona eklendi: dev_eui={}, {} tag, tampon boyutu={}",
                    dev_eui,
                    decoded_values.len(),
                    self.pending_io_data.len()
                );

                // MQTT yayinlari icin state lock'u kisa sure alinir
                let state = self.state.read().await;

                // LoRa event yayinla — Batch #255 ARC-002 migration:
                // routes via publish_helpers (Outbound when wired).
                let event_payload = serde_json::json!({
                    "event_type": "uplink_summary",
                    "dev_eui": format!("{}", dev_eui),
                    "dev_addr": format!("{}", dev_addr),
                    "f_port": f_port,
                    "frame_count_up": f_cnt,
                    "rssi": rssi,
                    "snr": snr,
                    "values": decoded_values.iter()
                        .map(|(k, v)| serde_json::json!({"tag": k, "value": v}))
                        .collect::<Vec<_>>(),
                    "timestamp": chrono::Utc::now().to_rfc3339(),
                });
                crate::publish_helpers::publish_lora_event(&state, &event_payload).await;
            }

            MacEvent::SendJoinAccept {
                tx_packet,
                dev_eui,
                dev_addr,
            } => {
                info!(
                    "Join-Accept gonderiliyor: dev_eui={}, dev_addr={}, {} byte",
                    dev_eui,
                    dev_addr,
                    tx_packet.payload.len()
                );
                // Radyodan gonder
                if let Some(ref sx) = self.sx1302 {
                    if let Err(e) = sx.transmit(&tx_packet) {
                        error!("Join-Accept TX hatasi: {}", e);
                    }
                }
                // MQTT join event yayinla — Batch #255 ARC-002.
                let state = self.state.read().await;
                let event = serde_json::json!({
                    "event_type": "join_accept",
                    "dev_eui": format!("{}", dev_eui),
                    "dev_addr": format!("{}", dev_addr),
                    "timestamp": chrono::Utc::now().to_rfc3339(),
                });
                crate::publish_helpers::publish_lora_event(&state, &event).await;
            }

            MacEvent::SendDownlink { tx_packet } => {
                debug!("Downlink gonderiliyor: {} byte", tx_packet.payload.len());
                if let Some(ref sx) = self.sx1302 {
                    if let Err(e) = sx.transmit(&tx_packet) {
                        error!("Downlink TX hatasi: {}", e);
                    }
                }
            }

            MacEvent::FrameCounterReset {
                dev_eui,
                old_cnt,
                new_cnt,
            } => {
                warn!(
                    "Frame counter sifirlandi: dev_eui={}, eski={}, yeni={}. \
                     Cihaz yeniden baslatilmis olabilir veya replay attack!",
                    dev_eui, old_cnt, new_cnt
                );
            }

            MacEvent::UnknownDevice { dev_eui, dev_addr } => {
                debug!(
                    "Bilinmeyen cihaz: dev_eui={:?}, dev_addr={:?}",
                    dev_eui, dev_addr
                );
            }
        }
    }

    /// Bekleyen io_data tamponunu topluca MQTT'ye yayinlar
    ///
    /// 100ms penceresi icerisinde biriken tum uplink sensor verilerini
    /// tek bir MQTT mesajinda gonderir. 50 uplink/100ms = 1 MQTT publish.
    /// Bu, MQTT broker yukunu 50x azaltir.
    async fn flush_pending_io_data(&mut self) {
        if self.pending_io_data.is_empty() {
            return;
        }

        // Tamponu drain et — yeni veriler sonraki pencereye gider
        let batch: Vec<(String, f64, TagQuality)> = std::mem::take(&mut self.pending_io_data);
        let tag_count = batch.len();

        // io_tags HashMap'i olustur
        let mut io_tags = HashMap::new();
        for (tag_name, value, quality) in &batch {
            let quality_str = serde_json::to_value(quality)
                .ok()
                .and_then(|v| v.as_str().map(|s| s.to_string()))
                .unwrap_or_else(|| "good".to_string());
            io_tags.insert(
                tag_name.clone(),
                IoTagData {
                    value: serde_json::json!(value),
                    quality: quality_str,
                    simulated: quality.is_simulated(),
                },
            );
        }

        // MQTT'ye topluca yayinla — Batch #255 ARC-002 migration.
        let state = self.state.read().await;
        let payload = IoDataPayload {
            timestamp: chrono::Utc::now().to_rfc3339(),
            tags: io_tags,
        };
        crate::publish_helpers::publish_io_data(&state, &payload).await;
        debug!("LoRa io_data batch yayinlandi: {} tag", tag_count);
    }
}

// ============================================================================
// Yapilandirma Yardimcilari
// ============================================================================

/// Bolge string'ini LoRaRegion enum'una cevirir
fn parse_region(region_str: &str) -> Result<LoRaRegion> {
    match region_str.to_uppercase().as_str() {
        "EU868" => Ok(LoRaRegion::Eu868),
        "US915" => Ok(LoRaRegion::Us915),
        "CN470" => Ok(LoRaRegion::Cn470),
        "AU915" => Ok(LoRaRegion::Au915),
        "AS923" => Ok(LoRaRegion::As923),
        "KR920" => Ok(LoRaRegion::Kr920),
        "IN865" => Ok(LoRaRegion::In865),
        other => anyhow::bail!("Bilinmeyen LoRa bolgesi: '{}'", other),
    }
}

/// NetID hex string'ini 3-byte array'e cevirir
fn parse_net_id(net_id_str: &str) -> Result<[u8; 3]> {
    let clean = net_id_str.trim_start_matches("0x").trim_start_matches("0X");
    if clean.len() != 6 {
        anyhow::bail!(
            "NetID hex string 6 karakter olmali, '{}' verildi",
            net_id_str
        );
    }

    let mut bytes = [0u8; 3];
    for i in 0..3 {
        bytes[i] = u8::from_str_radix(&clean[i * 2..i * 2 + 2], 16)
            .with_context(|| format!("NetID hex parse hatasi: '{}'", net_id_str))?;
    }
    Ok(bytes)
}

/// YAML cihaz yapilandirmasini LoRaDeviceConfig'e cevirir
///
/// Public: commands.rs'den update_lora_devices komutu icin kullanilir.
pub fn parse_device_config(yaml: &crate::config::LoRaDeviceConfigYaml) -> Result<LoRaDeviceConfig> {
    let dev_eui = DevEui::from_hex(&yaml.dev_eui)
        .map_err(|e| anyhow::anyhow!("DevEUI parse hatasi: {}", e))?;

    let app_eui = types::AppEui::from_hex(&yaml.app_eui)
        .map_err(|e| anyhow::anyhow!("AppEUI parse hatasi: {}", e))?;

    let app_key = types::AppKey::from_hex(&yaml.app_key)
        .map_err(|e| anyhow::anyhow!("AppKey parse hatasi: {}", e))?;

    let activation = match yaml.activation.to_lowercase().as_str() {
        "otaa" => types::ActivationMode::Otaa,
        "abp" => types::ActivationMode::Abp,
        other => anyhow::bail!("Bilinmeyen aktivasyon modu: '{}'", other),
    };

    let device_class = match yaml.device_class.to_uppercase().as_str() {
        "A" => types::DeviceClass::A,
        "B" => types::DeviceClass::B,
        "C" => types::DeviceClass::C,
        other => anyhow::bail!("Bilinmeyen cihaz sinifi: '{}'", other),
    };

    let codec = match yaml.codec.to_lowercase().as_str() {
        "cayenne_lpp" | "cayennelpp" => types::CodecType::CayenneLpp,
        "raw_binary" | "rawbinary" => types::CodecType::RawBinary {
            byte_order: types::ByteOrder::BigEndian,
        },
        other => types::CodecType::Custom {
            decoder_name: other.to_string(),
        },
    };

    Ok(LoRaDeviceConfig {
        dev_eui,
        app_eui,
        app_key,
        activation,
        device_class,
        tag_prefix: yaml.tag_prefix.clone(),
        codec,
        rx1_delay_secs: yaml.rx1_delay_secs,
        rx2_datarate: yaml.rx2_datarate,
        rx2_freq_hz: yaml.rx2_freq_hz,
        adr_enabled: yaml.adr_enabled,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_region() {
        assert!(matches!(parse_region("EU868").unwrap(), LoRaRegion::Eu868));
        assert!(matches!(parse_region("us915").unwrap(), LoRaRegion::Us915));
        assert!(parse_region("INVALID").is_err());
    }

    #[test]
    fn test_parse_net_id() {
        let net_id = parse_net_id("000001").unwrap();
        assert_eq!(net_id, [0x00, 0x00, 0x01]);

        let net_id = parse_net_id("0xABCDEF").unwrap();
        assert_eq!(net_id, [0xAB, 0xCD, 0xEF]);

        assert!(parse_net_id("00").is_err());
    }
}
