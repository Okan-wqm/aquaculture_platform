//! LoRaWAN Oturum Deposu (Session Store)
//!
//! SQLite tabanli kalici oturum yonetimi. LoRa cihazlarinin oturum anahtarlari,
//! frame sayaclari ve bekleyen join istekleri bu moduldedir.
//!
//! # Neden Kalici Depolama?
//! LoRaWAN'da oturum anahtarlari ve frame sayaclari kritik oneme sahiptir:
//! - Gateway yeniden basladiginda aktif oturumlarin korunmasi gerekir
//! - Frame sayaci kaybi, replay attack korumasini kirar (cihaz re-join gerektirir)
//! - ABP cihazlar icin oturum anahtarlari kalici olmalidir (join mekanizmasi yok)
//!
//! # Guvenlik (IEC 62443 FR4)
//! - SQLCipher ile AES-256-CBC sifreleme (offline_queue.rs ile ayni anahtar turetme)
//! - WAL modu ile concurrent erisim destegi
//! - Hassas anahtar verileri sifreli diskte saklanir
//!
//! # Tasarim
//! offline_queue.rs ile ayni pattern: Mutex<Connection> + acquire_lock + WAL mode

use anyhow::{Context, Result};
use rusqlite::{Connection, params};
use std::path::Path;
use std::sync::Mutex;
use tracing::{debug, info, warn};

use super::types::{DevAddr, DevEui, DeviceClass, SessionKeys};

// ============================================================================
// Oturum Deposu (Session Store)
// ============================================================================

/// SQLite tabanli LoRaWAN oturum deposu
///
/// Her aktif cihazin oturum anahtarlari, frame sayaclari ve
/// yapilandirma bilgilerini kalici olarak saklar.
/// Bekleyen OTAA join isteklerini de yonetir.
pub struct SessionStore {
    /// SQLite baglantisi (Mutex ile thread-safe erisim)
    db: Mutex<Connection>,
}

/// Veritabanindan okunan oturum bilgisi
///
/// SessionKeys + ek meta veri (cihaz sinifi, son gorulen zaman, tag prefix, codec)
#[derive(Debug, Clone)]
pub struct StoredSession {
    /// Cihaz EUI (birincil anahtar)
    pub dev_eui: DevEui,
    /// Oturum anahtarlari ve frame sayaclari
    pub keys: SessionKeys,
    /// Cihaz sinifi (A/B/C)
    pub device_class: DeviceClass,
    /// Son paket alinan zaman (Unix epoch saniye)
    pub last_seen: i64,
    /// RX1 gecikme suresi (saniye)
    pub rx1_delay_secs: u32,
    /// RX2 veri hizi
    pub rx2_datarate: u8,
    /// RX2 frekans (Hz)
    pub rx2_freq_hz: u32,
    /// Tag isimlendirme on eki
    pub tag_prefix: String,
    /// Codec yapilandirmasi (JSON olarak saklanir)
    pub codec_json: String,
}

/// Bekleyen OTAA join istegi
///
/// Cihaz join-request gonderdiginde, DevNonce ve AppKey bilgisi
/// join-accept gelene kadar saklanir. Join-accept islendiginde
/// oturum anahtarlari turetilir ve bu kayit silinir.
#[derive(Debug, Clone)]
pub struct PendingJoin {
    pub dev_eui: DevEui,
    /// Cihazin join-request'te gonderdigi 2-byte rastgele deger
    /// Ayni DevNonce tekrar kullanilamaz (replay koruması)
    pub dev_nonce: [u8; 2],
    /// Root uygulama anahtari (oturum anahtar turetimi icin)
    pub app_key: [u8; 16],
    /// Join isteginin olusturulma zamani (Unix epoch saniye)
    pub created_at: i64,
}

impl SessionStore {
    /// Yeni bir oturum deposu olusturur
    ///
    /// Veritabani dosyasi yoksa olusturulur.
    /// SQLCipher sifreleme, WAL modu ve tablo semalari otomatik uygulanir.
    ///
    /// # Parametreler
    /// - `db_path`: SQLite veritabani dosya yolu
    pub fn new(db_path: &Path) -> Result<Self> {
        // EDGE-HIGH-026: open + key via the canonical SQLCipher factory
        // (v1 device-secret key). This also corrects the former outlier
        // pragma profile (cache_size=-2000, no busy_timeout/auto_vacuum) to
        // the canonical durability sequence the factory owns.
        //
        // PR935-MEDIUM-001: the DURABLE profile (synchronous=FULL) makes every
        // commit power-loss durable. This store persists the LoRaWAN uplink
        // frame counter (EDGE-HIGH-017); at synchronous=NORMAL a power cut can
        // lose the last advances and reopen the replay window. Uplink rates
        // are radio-bounded, so per-commit fsync is affordable.
        let conn = crate::db::sqlcipher_factory::open_device_secret(
            db_path,
            "lora_session",
            crate::db::sqlcipher_factory::PragmaProfile::DURABLE,
        )?;

        let store = Self {
            db: Mutex::new(conn),
        };

        store.init_schema()?;
        info!(
            "LoRa session store baslatildi (WAL modu aktif): {}",
            db_path.display()
        );

        Ok(store)
    }

    /// Test icin bellek-ici veritabani olusturur (sifreleme yok)
    #[cfg(test)]
    pub fn in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().context("Bellek-ici session DB olusturulamadi")?;

        let store = Self {
            db: Mutex::new(conn),
        };

        store.init_schema()?;
        Ok(store)
    }

    /// Mutex kilidini alir (poison recovery ile)
    ///
    /// offline_queue.rs'deki acquire_lock pattern'i ile ayni mantik.
    /// Onceki thread paniklemisse kilidi kurtarir.
    fn acquire_lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>> {
        match self.db.lock() {
            Ok(guard) => Ok(guard),
            Err(poisoned) => {
                tracing::error!(
                    "LoRa session DB mutex poisoned, kurtariliyor. \
                    Veri tutarsiz olabilir - agent yeniden baslatmayi deneyin."
                );
                Ok(poisoned.into_inner())
            }
        }
    }

    /// Veritabani semasini olusturur
    ///
    /// - sessions tablosu: Aktif cihaz oturumlari
    /// - pending_joins tablosu: Bekleyen OTAA join istekleri
    fn init_schema(&self) -> Result<()> {
        let conn = self.acquire_lock()?;

        conn.execute_batch(
            "
            -- PR935-MEDIUM-001/002: journal_mode / synchronous / busy_timeout
            -- are owned by the SQLCipher factory (DURABLE profile → FULL). This
            -- schema init MUST NOT re-emit synchronous=NORMAL — doing so would
            -- silently downgrade the frame-counter durability guarantee.

            -- Aktif oturumlar tablosu
            -- dev_eui: Cihaz benzersiz kimligi (hex string, PK)
            -- dev_addr: Ag adresi (hex string) - uplink'lerde bu adresle eslestirme yapilir
            -- nwk_s_key/app_s_key: Oturum anahtarlari (hex string, 32 char)
            -- f_cnt_up/f_cnt_down: Frame sayaclari (replay koruması icin kritik)
            CREATE TABLE IF NOT EXISTS sessions (
                dev_eui TEXT PRIMARY KEY NOT NULL,
                dev_addr TEXT NOT NULL,
                nwk_s_key TEXT NOT NULL,
                app_s_key TEXT NOT NULL,
                f_cnt_up INTEGER NOT NULL DEFAULT 0,
                f_cnt_down INTEGER NOT NULL DEFAULT 0,
                device_class TEXT NOT NULL DEFAULT 'A',
                last_seen INTEGER NOT NULL,
                rx1_delay_secs INTEGER NOT NULL DEFAULT 1,
                rx2_datarate INTEGER NOT NULL DEFAULT 0,
                rx2_freq_hz INTEGER NOT NULL DEFAULT 869525000,
                tag_prefix TEXT NOT NULL DEFAULT '',
                codec_json TEXT NOT NULL DEFAULT '{\"cayenne_lpp\":null}'
            );

            -- DevAddr uzerinde index: Her uplink paketi DevAddr ile gelir,
            -- hizli eslestirme icin gerekli
            CREATE INDEX IF NOT EXISTS idx_sessions_dev_addr
            ON sessions (dev_addr);

            -- Bekleyen join istekleri tablosu
            -- Join-request alindiktan sonra join-accept gonderilene kadar
            -- DevNonce ve AppKey saklanir
            CREATE TABLE IF NOT EXISTS pending_joins (
                dev_eui TEXT PRIMARY KEY NOT NULL,
                dev_nonce TEXT NOT NULL,
                app_key TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            -- Kullanilmis DevNonce'lar tablosu (replay koruması)
            -- OTAA join-request'te ayni DevNonce tekrar kullanilamaz (LoRaWAN 1.0.x Spec 6.2.4)
            -- Her basarili join icin DevNonce kaydedilir, tekrar eden nonce reddedilir
            CREATE TABLE IF NOT EXISTS used_dev_nonces (
                dev_eui TEXT NOT NULL,
                dev_nonce TEXT NOT NULL,
                used_at INTEGER NOT NULL,
                PRIMARY KEY (dev_eui, dev_nonce)
            );
            ",
        )
        .context("LoRa session sema olusturulamadi")?;

        Ok(())
    }

    // ========================================================================
    // Oturum Islemleri (Session Operations)
    // ========================================================================

    /// DevAddr ile oturum arar
    ///
    /// Her uplink paketinde sadece DevAddr bulunur (DevEUI degil).
    /// Bu metod, paketin hangi cihaza ait oldugunu bulmak icin kullanilir.
    ///
    /// Birden fazla cihaz ayni DevAddr'e sahip olabilir (nadir ama mumkun),
    /// bu durumda MIC dogrulamasi ile dogru cihaz secilir.
    pub fn get_session(&self, dev_addr: &DevAddr) -> Result<Option<StoredSession>> {
        let conn = self.acquire_lock()?;
        let dev_addr_hex = format!("{}", dev_addr);

        let result = conn.query_row(
            "SELECT dev_eui, dev_addr, nwk_s_key, app_s_key, f_cnt_up, f_cnt_down,
                    device_class, last_seen, rx1_delay_secs, rx2_datarate, rx2_freq_hz,
                    tag_prefix, codec_json
             FROM sessions WHERE dev_addr = ?1",
            params![dev_addr_hex],
            |row| {
                Ok(RawSessionRow {
                    dev_eui: row.get(0)?,
                    dev_addr: row.get(1)?,
                    nwk_s_key: row.get(2)?,
                    app_s_key: row.get(3)?,
                    f_cnt_up: row.get(4)?,
                    f_cnt_down: row.get(5)?,
                    device_class: row.get(6)?,
                    last_seen: row.get(7)?,
                    rx1_delay_secs: row.get(8)?,
                    rx2_datarate: row.get(9)?,
                    rx2_freq_hz: row.get(10)?,
                    tag_prefix: row.get(11)?,
                    codec_json: row.get(12)?,
                })
            },
        );

        match result {
            Ok(raw) => Ok(Some(parse_session_row(raw)?)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(anyhow::anyhow!("Session sorgusu hatasi: {}", e)),
        }
    }

    /// Oturumu kaydeder veya gunceller
    ///
    /// Join-accept islendikten sonra yeni oturum kaydi olusturulur.
    /// Zaten mevcut bir oturum varsa (re-join durumu) ustune yazilir.
    pub fn save_session(&self, session: &StoredSession) -> Result<()> {
        let conn = self.acquire_lock()?;

        let dev_eui_hex = format!("{}", session.dev_eui);
        let dev_addr_hex = format!("{}", session.keys.dev_addr);
        let nwk_s_key_hex = hex::encode(session.keys.nwk_s_key);
        let app_s_key_hex = hex::encode(session.keys.app_s_key);
        let device_class = match session.device_class {
            DeviceClass::A => "A",
            DeviceClass::B => "B",
            DeviceClass::C => "C",
        };

        conn.execute(
            "INSERT OR REPLACE INTO sessions
                (dev_eui, dev_addr, nwk_s_key, app_s_key, f_cnt_up, f_cnt_down,
                 device_class, last_seen, rx1_delay_secs, rx2_datarate, rx2_freq_hz,
                 tag_prefix, codec_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                dev_eui_hex,
                dev_addr_hex,
                nwk_s_key_hex,
                app_s_key_hex,
                session.keys.f_cnt_up,
                session.keys.f_cnt_down,
                device_class,
                session.last_seen,
                session.rx1_delay_secs,
                session.rx2_datarate,
                session.rx2_freq_hz,
                session.tag_prefix,
                session.codec_json,
            ],
        )
        .context("Oturum kaydedilemedi")?;

        debug!(
            "Oturum kaydedildi: dev_eui={}, dev_addr={}",
            dev_eui_hex, dev_addr_hex
        );
        Ok(())
    }

    /// Uplink frame sayacini ATOMİK olarak dogrular VE kalici olarak
    /// ilerletir (EDGE-HIGH-017).
    ///
    /// `f_cnt` sema uzerindeki `f_cnt_up` (= beklenen sonraki sayac)
    /// degerinden buyuk-esitse taze kabul edilir; tek bir korumali UPDATE
    /// ile sayac `f_cnt + 1`'e ilerletilip commit edilir ve `Ok(true)`
    /// doner. Aksi halde (replay / bayat) hicbir satir guncellenmez ve
    /// `Ok(false)` doner.
    ///
    /// Dogrulama ve ilerletme TEK bir dayanikli islemdir: `WHERE ... AND
    /// ?f_cnt >= f_cnt_up` kosulu monoton kapiyi dogrudan veritabaninda
    /// uygular, boylece "oku-sonra-baska-yere-yaz" penceresi (ayni surec
    /// icinde VEYA cokme/yeniden-baslatma sonrasi) YAPISAL OLARAK olusamaz.
    /// Bu, replay korumasinin OTORİTE kapisidir. Dayaniklilik WAL +
    /// `synchronous=NORMAL`'dan gelir (bkz. `new`): commit edilen WAL
    /// cerceveleri yeniden acilista tekrar oynatilir, bu da panik +
    /// systemd `Restart=always` tehdidini kapsar.
    pub fn check_and_advance_f_cnt_up(&self, dev_eui: &DevEui, f_cnt: u32) -> Result<bool> {
        let conn = self.acquire_lock()?;
        let now = chrono::Utc::now().timestamp();
        let dev_eui_hex = format!("{}", dev_eui);
        let rows = conn
            .execute(
                "UPDATE sessions
                    SET f_cnt_up = ?1, last_seen = ?2
                  WHERE dev_eui = ?3 AND ?4 >= f_cnt_up",
                // PR935-LOW-006: saturating_add so the stored next-expected
                // counter cannot wrap to 0 at u32::MAX (release has no
                // overflow-checks) — a wrap would reopen the replay window.
                params![f_cnt.saturating_add(1), now, dev_eui_hex, f_cnt],
            )
            .context("FCntUp dogrula-ve-ilerlet basarisiz")?;
        Ok(rows == 1)
    }

    /// Downlink frame sayacini arttirir ve yeni degeri dondurur
    ///
    /// Her downlink paketi gonderildiginde FCntDown arttirilir.
    /// Atomik okuma + artirma islemi yapilir.
    pub fn increment_f_cnt_down(&self, dev_eui: &DevEui) -> Result<u32> {
        let conn = self.acquire_lock()?;
        let dev_eui_hex = format!("{}", dev_eui);

        conn.execute(
            "UPDATE sessions SET f_cnt_down = f_cnt_down + 1 WHERE dev_eui = ?1",
            params![dev_eui_hex],
        )
        .context("FCntDown artirilamadi")?;

        let new_cnt: u32 = conn
            .query_row(
                "SELECT f_cnt_down FROM sessions WHERE dev_eui = ?1",
                params![dev_eui_hex],
                |row| row.get(0),
            )
            .context("FCntDown okunamadi")?;

        Ok(new_cnt)
    }

    /// Aktif oturum sayisini dondurur (istatistik amaciyla)
    pub fn count_active(&self) -> Result<u64> {
        let conn = self.acquire_lock()?;

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .context("Aktif oturum sayisi alinamadi")?;

        Ok(count as u64)
    }

    /// Belirli suredir inaktif olan oturumlari temizler
    ///
    /// Uzun suredir paket gondermeyen cihazlarin oturumlari silinir.
    /// Bu, cihazlarin re-join yapmasini zorunlu kilar (guvenlik iyilestirmesi).
    ///
    /// # Parametreler
    /// - `max_idle_secs`: Maksimum inaktivite suresi (saniye)
    pub fn cleanup_stale(&self, max_idle_secs: i64) -> Result<usize> {
        // EDGE-HIGH-017: her uplink `last_seen`'i write-through olarak
        // gunceller (check_and_advance_f_cnt_up), dolayisiyla flush edilmemis
        // bir cache yoktur — DB daima gunceldir, on-flush gereksizdir.
        let conn = self.acquire_lock()?;
        let cutoff = chrono::Utc::now().timestamp() - max_idle_secs;

        let deleted = conn
            .execute("DELETE FROM sessions WHERE last_seen < ?1", params![cutoff])
            .context("Eski oturumlar temizlenemedi")?;

        if deleted > 0 {
            info!(
                "{} eski oturum temizlendi (idle > {} sn)",
                deleted, max_idle_secs
            );
        }

        Ok(deleted)
    }

    // ========================================================================
    // Bekleyen Join Islemleri (Pending Join Operations)
    // ========================================================================

    /// Bekleyen join istegini kaydeder
    ///
    /// Bir cihazdan join-request alındiginda, join-accept gonderilene kadar
    /// DevNonce ve AppKey bilgisi saklanir. Daha sonra bu bilgilerle
    /// oturum anahtarlari turetilir.
    pub fn save_pending_join(&self, pending: &PendingJoin) -> Result<()> {
        let conn = self.acquire_lock()?;
        let dev_eui_hex = format!("{}", pending.dev_eui);
        let dev_nonce_hex = hex::encode(pending.dev_nonce);
        let app_key_hex = hex::encode(pending.app_key);

        conn.execute(
            "INSERT OR REPLACE INTO pending_joins (dev_eui, dev_nonce, app_key, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![dev_eui_hex, dev_nonce_hex, app_key_hex, pending.created_at],
        )
        .context("Bekleyen join kaydedilemedi")?;

        debug!("Bekleyen join kaydedildi: dev_eui={}", dev_eui_hex);
        Ok(())
    }

    /// Bekleyen join istegini getirir
    pub fn get_pending_join(&self, dev_eui: &DevEui) -> Result<Option<PendingJoin>> {
        let conn = self.acquire_lock()?;
        let dev_eui_hex = format!("{}", dev_eui);

        let result = conn.query_row(
            "SELECT dev_eui, dev_nonce, app_key, created_at
             FROM pending_joins WHERE dev_eui = ?1",
            params![dev_eui_hex],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        );

        match result {
            Ok((eui_hex, nonce_hex, key_hex, created_at)) => {
                let dev_eui = DevEui::from_hex(&eui_hex)
                    .map_err(|e| anyhow::anyhow!("DevEui parse hatasi: {}", e))?;

                let nonce_bytes = hex_to_fixed::<2>(&nonce_hex)
                    .ok_or_else(|| anyhow::anyhow!("DevNonce hex parse hatasi"))?;

                let key_bytes = hex_to_fixed::<16>(&key_hex)
                    .ok_or_else(|| anyhow::anyhow!("AppKey hex parse hatasi"))?;

                Ok(Some(PendingJoin {
                    dev_eui,
                    dev_nonce: nonce_bytes,
                    app_key: key_bytes,
                    created_at,
                }))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(anyhow::anyhow!("Bekleyen join sorgusu hatasi: {}", e)),
        }
    }

    /// Bekleyen join istegini siler
    ///
    /// Join-accept basariyla islendikten sonra bekleyen kayit
    /// artik gerekli degildir ve silinir.
    pub fn remove_pending_join(&self, dev_eui: &DevEui) -> Result<()> {
        let conn = self.acquire_lock()?;
        let dev_eui_hex = format!("{}", dev_eui);

        conn.execute(
            "DELETE FROM pending_joins WHERE dev_eui = ?1",
            params![dev_eui_hex],
        )
        .context("Bekleyen join silinemedi")?;

        debug!("Bekleyen join silindi: dev_eui={}", dev_eui_hex);
        Ok(())
    }

    // ========================================================================
    // DevNonce Replay Korumasi (DevNonce Replay Protection)
    // ========================================================================

    /// Kullanilmis DevNonce'u kaydeder
    ///
    /// Basarili bir join-accept islendikten sonra, kullanilan DevNonce
    /// veritabanina kaydedilir. Ayni DevNonce tekrar kullanilamaz
    /// (LoRaWAN 1.0.x Spec 6.2.4 - replay koruması).
    pub fn save_used_dev_nonce(&self, dev_eui: &DevEui, dev_nonce: &[u8; 2]) -> Result<()> {
        let conn = self.acquire_lock()?;
        let dev_eui_hex = format!("{}", dev_eui);
        let dev_nonce_hex = hex::encode(*dev_nonce);
        let now = chrono::Utc::now().timestamp();

        conn.execute(
            "INSERT OR IGNORE INTO used_dev_nonces (dev_eui, dev_nonce, used_at)
             VALUES (?1, ?2, ?3)",
            params![dev_eui_hex, dev_nonce_hex, now],
        )
        .context("DevNonce kaydedilemedi")?;

        debug!(
            "DevNonce kaydedildi: dev_eui={}, nonce={}",
            dev_eui_hex, dev_nonce_hex
        );
        Ok(())
    }

    /// DevNonce'un daha once kullanilip kullanilmadigini kontrol eder
    ///
    /// Join-request isleme sirasinda, MIC dogrulamasindan ONCE cagrilmalidir.
    /// Eger nonce daha once kullanildiysa, join-request reddedilir.
    pub fn is_dev_nonce_used(&self, dev_eui: &DevEui, dev_nonce: &[u8; 2]) -> Result<bool> {
        let conn = self.acquire_lock()?;
        let dev_eui_hex = format!("{}", dev_eui);
        let dev_nonce_hex = hex::encode(*dev_nonce);

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM used_dev_nonces WHERE dev_eui = ?1 AND dev_nonce = ?2",
                params![dev_eui_hex, dev_nonce_hex],
                |row| row.get(0),
            )
            .context("DevNonce kontrol sorgusu hatasi")?;

        Ok(count > 0)
    }
}

// ============================================================================
// Yardimci Fonksiyonlar (Helper Functions)
// ============================================================================

/// SQLite satir verisi (parse oncesi ham degerler)
struct RawSessionRow {
    dev_eui: String,
    dev_addr: String,
    nwk_s_key: String,
    app_s_key: String,
    f_cnt_up: u32,
    f_cnt_down: u32,
    device_class: String,
    last_seen: i64,
    rx1_delay_secs: u32,
    rx2_datarate: u8,
    rx2_freq_hz: u32,
    tag_prefix: String,
    codec_json: String,
}

/// Ham SQLite satirini StoredSession'a donusturur
fn parse_session_row(raw: RawSessionRow) -> Result<StoredSession> {
    let dev_eui =
        DevEui::from_hex(&raw.dev_eui).map_err(|e| anyhow::anyhow!("DevEui parse: {}", e))?;

    let dev_addr =
        DevAddr::from_hex(&raw.dev_addr).map_err(|e| anyhow::anyhow!("DevAddr parse: {}", e))?;

    let nwk_s_key = hex_to_fixed::<16>(&raw.nwk_s_key)
        .ok_or_else(|| anyhow::anyhow!("NwkSKey hex parse hatasi"))?;

    let app_s_key = hex_to_fixed::<16>(&raw.app_s_key)
        .ok_or_else(|| anyhow::anyhow!("AppSKey hex parse hatasi"))?;

    let device_class = match raw.device_class.as_str() {
        "A" => DeviceClass::A,
        "B" => DeviceClass::B,
        "C" => DeviceClass::C,
        other => {
            warn!("Bilinmeyen device class '{}', Class A varsayiliyor", other);
            DeviceClass::A
        }
    };

    Ok(StoredSession {
        dev_eui,
        keys: SessionKeys {
            nwk_s_key,
            app_s_key,
            dev_addr,
            f_cnt_up: raw.f_cnt_up,
            f_cnt_down: raw.f_cnt_down,
        },
        device_class,
        last_seen: raw.last_seen,
        rx1_delay_secs: raw.rx1_delay_secs,
        rx2_datarate: raw.rx2_datarate,
        rx2_freq_hz: raw.rx2_freq_hz,
        tag_prefix: raw.tag_prefix,
        codec_json: raw.codec_json,
    })
}

/// Hex string'i sabit boyutlu byte array'e donusturur
///
/// Genel amacli yardimci fonksiyon, N byte uzunlugundaki hex string'leri parse eder.
fn hex_to_fixed<const N: usize>(hex: &str) -> Option<[u8; N]> {
    if hex.len() != N * 2 {
        return None;
    }
    let mut bytes = [0u8; N];
    for i in 0..N {
        bytes[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(bytes)
}

/// Byte slice'i hex string'e donusturur
fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// hex modulu - session.rs icinde kullanilan basit hex encode/decode
mod hex {
    pub fn encode(bytes: impl AsRef<[u8]>) -> String {
        bytes
            .as_ref()
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_test_session() -> StoredSession {
        StoredSession {
            dev_eui: DevEui([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]),
            keys: SessionKeys {
                nwk_s_key: [0xAA; 16],
                app_s_key: [0xBB; 16],
                dev_addr: DevAddr([0x26, 0x01, 0x12, 0x34]),
                f_cnt_up: 0,
                f_cnt_down: 0,
            },
            device_class: DeviceClass::A,
            last_seen: chrono::Utc::now().timestamp(),
            rx1_delay_secs: 1,
            rx2_datarate: 0,
            rx2_freq_hz: 869_525_000,
            tag_prefix: "test_lora_".to_string(),
            codec_json: r#"{"cayenne_lpp":null}"#.to_string(),
        }
    }

    #[test]
    fn test_save_and_get_session() {
        let store = SessionStore::in_memory().expect("store olusturulamadi");
        let session = make_test_session();

        store.save_session(&session).expect("kayit basarisiz");

        let dev_addr = DevAddr([0x26, 0x01, 0x12, 0x34]);
        let loaded = store
            .get_session(&dev_addr)
            .expect("sorgu hatasi")
            .expect("oturum bulunamadi");

        assert_eq!(loaded.dev_eui, session.dev_eui);
        assert_eq!(loaded.keys.nwk_s_key, session.keys.nwk_s_key);
        assert_eq!(loaded.keys.app_s_key, session.keys.app_s_key);
        assert_eq!(loaded.keys.dev_addr, dev_addr);
        assert_eq!(loaded.tag_prefix, "test_lora_");
    }

    #[test]
    fn test_get_nonexistent_session() {
        let store = SessionStore::in_memory().expect("store olusturulamadi");
        let addr = DevAddr([0xFF, 0xFF, 0xFF, 0xFF]);
        let result = store.get_session(&addr).expect("sorgu hatasi");
        assert!(result.is_none());
    }

    // EDGE-HIGH-017: the atomic check-and-advance is the authoritative
    // anti-replay gate. Validation + durable advance are one transaction;
    // the advance is IMMEDIATELY visible to the next read (no flush).
    #[test]
    fn test_check_and_advance_accepts_fresh_and_persists() {
        let store = SessionStore::in_memory().expect("store olusturulamadi");
        let session = make_test_session(); // f_cnt_up = 0 (next-expected)
        store.save_session(&session).expect("kayit basarisiz");

        // Fresh uplink f_cnt=42 (>= next-expected 0) → accepted + advanced.
        let fresh = store
            .check_and_advance_f_cnt_up(&session.dev_eui, 42)
            .expect("advance hatasi");
        assert!(fresh, "fresh uplink must be accepted");

        // The advance is visible with NO flush — stored is the next-expected
        // value 43.
        let loaded = store
            .get_session(&session.keys.dev_addr)
            .expect("sorgu hatasi")
            .expect("oturum bulunamadi");
        assert_eq!(loaded.keys.f_cnt_up, 43);
    }

    #[test]
    fn test_check_and_advance_rejects_replay_and_stale() {
        let store = SessionStore::in_memory().expect("store olusturulamadi");
        let session = make_test_session();
        store.save_session(&session).expect("kayit basarisiz");

        assert!(
            store
                .check_and_advance_f_cnt_up(&session.dev_eui, 42)
                .expect("advance")
        );
        // Replay of the same counter → rejected (42 < next-expected 43).
        assert!(
            !store
                .check_and_advance_f_cnt_up(&session.dev_eui, 42)
                .expect("replay check"),
            "replay of the last counter must be rejected"
        );
        // A strictly lower (older) counter → rejected.
        assert!(
            !store
                .check_and_advance_f_cnt_up(&session.dev_eui, 10)
                .expect("stale check"),
            "a stale counter must be rejected"
        );
        // The stored counter is unchanged by the rejected attempts.
        let loaded = store
            .get_session(&session.keys.dev_addr)
            .expect("sorgu")
            .expect("oturum");
        assert_eq!(loaded.keys.f_cnt_up, 43);
    }

    #[test]
    fn test_check_and_advance_is_per_device_independent() {
        let store = SessionStore::in_memory().expect("store olusturulamadi");
        let mut sessions = Vec::new();
        for i in 0..3u8 {
            let mut s = make_test_session();
            s.dev_eui = DevEui([i + 1, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
            s.keys.dev_addr = DevAddr([0x26, 0x01, 0x12, i + 1]);
            store.save_session(&s).expect("kayit basarisiz");
            sessions.push(s);
        }

        // Each device advances independently and is immediately durable.
        for (i, s) in sessions.iter().enumerate() {
            let f_cnt = (i as u32 + 1) * 100;
            assert!(
                store
                    .check_and_advance_f_cnt_up(&s.dev_eui, f_cnt)
                    .expect("advance")
            );
        }

        for (i, s) in sessions.iter().enumerate() {
            let loaded = store
                .get_session(&s.keys.dev_addr)
                .expect("sorgu hatasi")
                .expect("oturum bulunamadi");
            assert_eq!(loaded.keys.f_cnt_up, (i as u32 + 1) * 100 + 1);
        }
    }

    #[test]
    fn test_increment_f_cnt_down() {
        let store = SessionStore::in_memory().expect("store olusturulamadi");
        let session = make_test_session();
        store.save_session(&session).expect("kayit basarisiz");

        let cnt1 = store
            .increment_f_cnt_down(&session.dev_eui)
            .expect("artirma hatasi");
        assert_eq!(cnt1, 1);

        let cnt2 = store
            .increment_f_cnt_down(&session.dev_eui)
            .expect("artirma hatasi");
        assert_eq!(cnt2, 2);
    }

    #[test]
    fn test_count_active() {
        let store = SessionStore::in_memory().expect("store olusturulamadi");
        assert_eq!(store.count_active().expect("sayim hatasi"), 0);

        store
            .save_session(&make_test_session())
            .expect("kayit basarisiz");
        assert_eq!(store.count_active().expect("sayim hatasi"), 1);
    }

    #[test]
    fn test_cleanup_stale() {
        let store = SessionStore::in_memory().expect("store olusturulamadi");
        let mut session = make_test_session();
        // 2 saat once gorulen cihaz
        session.last_seen = chrono::Utc::now().timestamp() - 7200;
        store.save_session(&session).expect("kayit basarisiz");

        // 1 saatlik idle limiti ile temizle
        let deleted = store.cleanup_stale(3600).expect("temizleme hatasi");
        assert_eq!(deleted, 1);
        assert_eq!(store.count_active().expect("sayim hatasi"), 0);
    }

    #[test]
    fn test_pending_join_lifecycle() {
        let store = SessionStore::in_memory().expect("store olusturulamadi");
        let dev_eui = DevEui([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);

        let pending = PendingJoin {
            dev_eui,
            dev_nonce: [0xAB, 0xCD],
            app_key: [0x2B; 16],
            created_at: chrono::Utc::now().timestamp(),
        };

        // Kaydet
        store.save_pending_join(&pending).expect("kayit basarisiz");

        // Getir
        let loaded = store
            .get_pending_join(&dev_eui)
            .expect("sorgu hatasi")
            .expect("bekleyen join bulunamadi");
        assert_eq!(loaded.dev_nonce, [0xAB, 0xCD]);
        assert_eq!(loaded.app_key, [0x2B; 16]);

        // Sil
        store.remove_pending_join(&dev_eui).expect("silme hatasi");
        let gone = store.get_pending_join(&dev_eui).expect("sorgu hatasi");
        assert!(gone.is_none());
    }

    #[test]
    fn test_hex_to_fixed() {
        let result = hex_to_fixed::<4>("AABBCCDD");
        assert_eq!(result, Some([0xAA, 0xBB, 0xCC, 0xDD]));

        let bad = hex_to_fixed::<4>("AABB");
        assert!(bad.is_none());
    }

    #[test]
    fn test_session_replace_on_rejoin() {
        let store = SessionStore::in_memory().expect("store olusturulamadi");
        let mut session = make_test_session();
        store.save_session(&session).expect("ilk kayit basarisiz");

        // Ayni dev_eui ile yeni oturum (re-join senaryosu)
        session.keys.nwk_s_key = [0xCC; 16];
        session.keys.f_cnt_up = 0;
        store.save_session(&session).expect("guncelleme basarisiz");

        let loaded = store
            .get_session(&session.keys.dev_addr)
            .expect("sorgu hatasi")
            .expect("oturum bulunamadi");
        assert_eq!(loaded.keys.nwk_s_key, [0xCC; 16]);
        assert_eq!(loaded.keys.f_cnt_up, 0);

        // Sadece 1 kayit olmali (replace)
        assert_eq!(store.count_active().expect("sayim hatasi"), 1);
    }

    #[test]
    fn test_dev_nonce_replay_protection() {
        let store = SessionStore::in_memory().expect("store olusturulamadi");
        let dev_eui = DevEui([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
        let nonce = [0xAB, 0xCD];

        // Ilk kullanim — kullanilmamis olmali
        assert!(
            !store
                .is_dev_nonce_used(&dev_eui, &nonce)
                .expect("sorgu hatasi")
        );

        // Kaydet
        store
            .save_used_dev_nonce(&dev_eui, &nonce)
            .expect("kayit hatasi");

        // Artik kullanilmis olmali
        assert!(
            store
                .is_dev_nonce_used(&dev_eui, &nonce)
                .expect("sorgu hatasi")
        );

        // Farkli nonce kullanilmamis olmali
        let other_nonce = [0x12, 0x34];
        assert!(
            !store
                .is_dev_nonce_used(&dev_eui, &other_nonce)
                .expect("sorgu hatasi")
        );

        // Farkli cihaz icin ayni nonce kullanilmamis olmali
        let other_dev = DevEui([0xFF; 8]);
        assert!(
            !store
                .is_dev_nonce_used(&other_dev, &nonce)
                .expect("sorgu hatasi")
        );
    }

    #[test]
    fn test_dev_nonce_duplicate_insert_ignored() {
        let store = SessionStore::in_memory().expect("store olusturulamadi");
        let dev_eui = DevEui([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
        let nonce = [0xAB, 0xCD];

        // Ayni nonce'u iki kez kaydetme hataya neden olmamali (INSERT OR IGNORE)
        store
            .save_used_dev_nonce(&dev_eui, &nonce)
            .expect("ilk kayit hatasi");
        store
            .save_used_dev_nonce(&dev_eui, &nonce)
            .expect("ikinci kayit hatasi");
    }
}
