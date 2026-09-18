//! LoRaWAN Shared Types
//!
//! LoRaWAN 1.0.x protokolunde kullanilan temel veri yapilari.
//! DevEUI, AppEUI, AppKey gibi kimlik bilgileri; oturum anahtarlari;
//! cihaz sinifi, aktivasyon modu ve bolge tanimlari bu moduldedir.
//!
//! # LoRaWAN Protokol Baglami
//! - DevEUI: Her cihaza uretici tarafindan atanan 64-bit benzersiz kimlik (IEEE EUI-64)
//! - AppEUI (JoinEUI): Uygulama sunucusunu tanimlayan 64-bit kimlik
//! - AppKey: OTAA join isleminde kullanilan 128-bit AES root anahtari
//! - DevAddr: Join-accept sonrasi atanan 32-bit ag adresi
//! - SessionKeys: Oturum sirasinda uplink/downlink sifreleme ve MIC icin kullanilir

use serde::{Deserialize, Serialize};
use std::fmt;
use zeroize::{Zeroize, ZeroizeOnDrop};

// ============================================================================
// Cihaz Kimlikleri (Device Identifiers)
// ============================================================================

/// 64-bit Device EUI - LoRaWAN cihazinin benzersiz kimligi (IEEE EUI-64 formati)
///
/// Her LoRa cihazi uretimde bir DevEUI alir. Join-request paketinde
/// ag sunucusuna gonderilir ve cihazin tanimlanmasinda kullanilir.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct DevEui(pub [u8; 8]);

impl fmt::Display for DevEui {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for byte in &self.0 {
            write!(f, "{:02X}", byte)?;
        }
        Ok(())
    }
}

impl fmt::Debug for DevEui {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "DevEui({})", self)
    }
}

impl DevEui {
    /// Hex string'den DevEui olusturur (16 karakter, orn: "0102030405060708")
    pub fn from_hex(hex: &str) -> Result<Self, String> {
        if hex.len() != 16 {
            return Err(format!(
                "DevEui hex string 16 karakter olmali, {} verildi",
                hex.len()
            ));
        }
        let mut bytes = [0u8; 8];
        for i in 0..8 {
            bytes[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
                .map_err(|e| format!("Gecersiz hex karakter: {}", e))?;
        }
        Ok(DevEui(bytes))
    }
}

/// 64-bit Application EUI (JoinEUI) - Uygulama sunucusunun kimligi
///
/// LoRaWAN 1.0.x'te AppEUI, 1.1'de JoinEUI olarak adlandirilir.
/// OTAA join-request paketinde DevEUI ile birlikte gonderilir.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AppEui(pub [u8; 8]);

impl fmt::Display for AppEui {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for byte in &self.0 {
            write!(f, "{:02X}", byte)?;
        }
        Ok(())
    }
}

impl fmt::Debug for AppEui {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "AppEui({})", self)
    }
}

impl AppEui {
    /// Hex string'den AppEui olusturur
    pub fn from_hex(hex: &str) -> Result<Self, String> {
        if hex.len() != 16 {
            return Err(format!(
                "AppEui hex string 16 karakter olmali, {} verildi",
                hex.len()
            ));
        }
        let mut bytes = [0u8; 8];
        for i in 0..8 {
            bytes[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
                .map_err(|e| format!("Gecersiz hex karakter: {}", e))?;
        }
        Ok(AppEui(bytes))
    }
}

/// 128-bit Application Key - OTAA aktivasyonda kullanilan root sifreleme anahtari
///
/// AppKey, join-accept mesajinin sifresini cozmek ve oturum anahtarlarini
/// (NwkSKey, AppSKey) turetmek icin kullanilir. Cihaz ve ag sunucusu
/// tarafindan onceden paylasilan gizli anahtardir.
///
/// # Guvenlik
/// Bu anahtar hassas veridir, bellekte saklanirken dikkatli olunmalidir.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct AppKey(pub [u8; 16]);

impl fmt::Display for AppKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Guvenlik: Sadece ilk ve son 2 byte'i goster, arasini maskele
        write!(
            f,
            "{:02X}{:02X}..{:02X}{:02X}",
            self.0[0], self.0[1], self.0[14], self.0[15]
        )
    }
}

impl fmt::Debug for AppKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "AppKey({})", self)
    }
}

impl AppKey {
    /// Hex string'den AppKey olusturur (32 karakter)
    pub fn from_hex(hex: &str) -> Result<Self, String> {
        if hex.len() != 32 {
            return Err(format!(
                "AppKey hex string 32 karakter olmali, {} verildi",
                hex.len()
            ));
        }
        let mut bytes = [0u8; 16];
        for i in 0..16 {
            bytes[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
                .map_err(|e| format!("Gecersiz hex karakter: {}", e))?;
        }
        Ok(AppKey(bytes))
    }
}

/// 32-bit Device Address - Ag tarafindan atanan cihaz adresi
///
/// Join-accept mesajinda ag sunucusu tarafindan cihaza verilir.
/// Her uplink/downlink paketinin MAC header'inda bulunur.
/// Ayni DevAddr birden fazla cihaza atanabilir (ag katmani ayirir).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct DevAddr(pub [u8; 4]);

impl fmt::Display for DevAddr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for byte in &self.0 {
            write!(f, "{:02X}", byte)?;
        }
        Ok(())
    }
}

impl fmt::Debug for DevAddr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "DevAddr({})", self)
    }
}

impl DevAddr {
    /// Hex string'den DevAddr olusturur (8 karakter)
    pub fn from_hex(hex: &str) -> Result<Self, String> {
        if hex.len() != 8 {
            return Err(format!(
                "DevAddr hex string 8 karakter olmali, {} verildi",
                hex.len()
            ));
        }
        let mut bytes = [0u8; 4];
        for i in 0..4 {
            bytes[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
                .map_err(|e| format!("Gecersiz hex karakter: {}", e))?;
        }
        Ok(DevAddr(bytes))
    }

    /// u32 degerinden DevAddr olusturur (big-endian)
    pub fn from_u32(val: u32) -> Self {
        DevAddr(val.to_be_bytes())
    }

    /// DevAddr'i u32 olarak dondurur (big-endian)
    pub fn to_u32(self) -> u32 {
        u32::from_be_bytes(self.0)
    }
}

// ============================================================================
// Oturum Anahtarlari (Session Keys)
// ============================================================================

/// LoRaWAN oturum anahtarlari - OTAA join veya ABP ile olusturulur
///
/// # LoRaWAN 1.0.x Oturum Yapisi
/// - NwkSKey: MAC komutlari ve MIC (Message Integrity Code) hesaplama icin
/// - AppSKey: Uygulama katmani payload sifreleme/cozme icin
/// - FCntUp: Cihazdan gelen paket sayaci (replay attack onleme)
/// - FCntDown: Sunucudan cihaza giden paket sayaci
///
/// Her iki taraf da (cihaz + sunucu) sayaclari takip eder.
/// Sayac uyusmazligi durumunda paket reddedilir.
#[derive(Debug, Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct SessionKeys {
    /// Network Session Key - MIC hesaplama ve MAC komut sifreleme (16 byte AES)
    pub nwk_s_key: [u8; 16],
    /// Application Session Key - Uygulama payload sifreleme (16 byte AES)
    pub app_s_key: [u8; 16],
    /// Cihaz adresi (join-accept ile atanan)
    #[zeroize(skip)]
    pub dev_addr: DevAddr,
    /// Uplink frame sayaci - her gondermede artar, tekrar saldirisini onler
    pub f_cnt_up: u32,
    /// Downlink frame sayaci - sunucu tarafindan arttirilir
    pub f_cnt_down: u32,
}

// ============================================================================
// Cihaz Yapilandirmasi (Device Configuration)
// ============================================================================

/// LoRaWAN aktivasyon modu
///
/// - OTAA (Over-The-Air Activation): Cihaz join-request gonderir, ag sunucusu
///   join-accept ile oturum anahtarlarini turetir. Daha guvenli, tavsiye edilen yontem.
/// - ABP (Activation By Personalization): Oturum anahtarlari onceden cihaza yuklenir.
///   Join islemi gerekmez ama guvenlik riski daha yuksektir.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivationMode {
    /// Over-The-Air Activation - Dinamik anahtar turetme (onerilen)
    Otaa,
    /// Activation By Personalization - Statik anahtar atama
    Abp,
}

/// LoRaWAN cihaz sinifi
///
/// - Class A: En dusuk guc tuketimi. Cihaz sadece uplink gonderdikten sonra
///   iki kisa alma penceresi acar (RX1, RX2). Pil ile calisan sensorler icin ideal.
/// - Class B: Zamanlama isaretleri (beacon) ile planli alma pencereleri acar.
///   Orta seviye gecikme gereksinimleri icin.
/// - Class C: Surekli dinleme modunda, en dusuk gecikme ama en yuksek guc tuketimi.
///   Sehir aydinlatmasi, aktuatorler gibi guc kaynagi olan cihazlar icin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DeviceClass {
    A,
    B,
    C,
}

/// LoRaWAN frekans bolge plani
///
/// Her bolge farkli frekans bantlari, veri hizlari ve regulator gereksinimleri belirler.
/// Cihaz ve gateway ayni bolge planini kullanmalidir.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum LoRaRegion {
    /// Avrupa 868 MHz - Turkiye dahil
    Eu868,
    /// ABD 915 MHz
    Us915,
    /// Cin 470 MHz
    Cn470,
    /// Avustralya 915 MHz
    Au915,
    /// Asya 923 MHz
    As923,
    /// Kore 920 MHz
    Kr920,
    /// Hindistan 865 MHz
    In865,
}

/// Payload codec (kod cozucu) turu
///
/// Gelen LoRa payload'inin nasil yorumlanacagini belirler.
/// Her cihaz ureticisi farkli bir format kullanabilir.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodecType {
    /// Cayenne Low Power Payload - Standart, yapilandirilmis sensor veri formati
    /// TLV (Type-Length-Value) yapisindadir, her sensor tipi icin sabit codec'ler vardir
    CayenneLpp,
    /// Ham binary - Her 4 byte bir f32 degeri olarak okunur
    RawBinary {
        /// Byte sirasi: "big_endian" veya "little_endian"
        byte_order: ByteOrder,
    },
    /// Ozel codec - Cihaz ureticisine ozel decoder adi ile eslenir
    Custom {
        /// Decoder fonksiyonunun adi (config'te tanimli script'e referans)
        decoder_name: String,
    },
}

/// Byte sirasi (endianness) - binary payload cozumlemede kullanilir
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ByteOrder {
    BigEndian,
    LittleEndian,
}

/// Tek bir LoRa cihazinin tam yapilandirmasi
///
/// YAML konfigurasyondan deserialize edilir, her cihaz icin
/// kimlik bilgileri, sinif, codec ve RF parametrelerini icerir.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoRaDeviceConfig {
    /// Cihaz benzersiz kimligi
    pub dev_eui: DevEui,
    /// Uygulama kimligi
    pub app_eui: AppEui,
    /// Root sifreleme anahtari (OTAA icin zorunlu)
    pub app_key: AppKey,
    /// Aktivasyon modu (OTAA onerilen)
    pub activation: ActivationMode,
    /// Cihaz sinifi (A/B/C)
    pub device_class: DeviceClass,
    /// Tag isimlendirme on eki (orn: "lora_sensor1_" -> "lora_sensor1_temperature")
    pub tag_prefix: String,
    /// Payload codec turu
    pub codec: CodecType,
    /// RX1 gecikme suresi (saniye), varsayilan 1
    pub rx1_delay_secs: Option<u32>,
    /// RX2 veri hizi, varsayilan bolgeye gore belirlenir
    pub rx2_datarate: Option<u8>,
    /// RX2 frekans (Hz)
    pub rx2_freq_hz: Option<u32>,
    /// Adaptive Data Rate aktif mi? ADR, ag sunucusunun cihazin
    /// veri hizini ve TX gucunu optimize etmesine izin verir
    pub adr_enabled: bool,
}

// ============================================================================
// RF Paket Yapilari (Radio Packet Structures)
// ============================================================================

/// Alinan LoRa paketi (uplink) - Gateway'den gelen ham RF verisi
///
/// SX1302 HAL'den alinan paket meta verileriyle birlikte.
/// RSSI ve SNR degerleri, cihazin kapsama alanini ve baglanti kalitesini gosterir.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RxPacket {
    /// Ham payload (PHYPayload): MHDR + MACPayload + MIC
    pub payload: Vec<u8>,
    /// Merkez frekans (Hz), orn: 868_100_000
    pub freq_hz: u32,
    /// LoRa veri hizi indeksi (DR0-DR15), bolgeden bolgeye degisir
    pub datarate: u8,
    /// Bant genisligi (kHz): 125, 250, 500
    pub bandwidth: u32,
    /// Alinan sinyal gucu (dBm) - ne kadar yuksekse o kadar iyi
    /// Tipik: -30 (yakin) ile -120 (uzak) arasi
    pub rssi: i16,
    /// Signal-to-Noise Ratio (dB) - pozitif = sinyal gurultudan guclu
    /// LoRa icin -20 dB'e kadar calisabilir (spread spectrum avantaji)
    pub snr: f32,
    /// Alinan zaman damgasi (mikrosaniye, gateway dahili sayaci)
    pub timestamp: u32,
    /// CRC gecerli mi? CRC hatali paketler genellikle atilir
    pub crc_ok: bool,
}

/// Gonderilecek LoRa paketi (downlink) - Gateway'e iletilecek RF verisi
///
/// Class A cihazlara sadece RX1/RX2 pencerelerinde gonderilebilir.
/// Zamanlama kritiktir - RX1_DELAY sonrasi tam zamaninda gonderilmelidir.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TxPacket {
    /// Ham payload (PHYPayload): MHDR + MACPayload + MIC
    pub payload: Vec<u8>,
    /// Merkez frekans (Hz)
    pub freq_hz: u32,
    /// LoRa veri hizi indeksi
    pub datarate: u8,
    /// Bant genisligi (kHz)
    pub bandwidth: u32,
    /// Gonderim gucu (dBm), bolgede izin verilen max degeri asmamali
    pub tx_power: i8,
    /// Gonderim zaman damgasi (mikrosaniye) - RX penceresiyle eslesmelidir
    /// Gateway'in dahili sayacina gore zamanlanir
    pub timestamp: u32,
    /// true ise zamanlama beklemeden hemen gonder (test/debug icin)
    pub immediate: bool,
}

// ============================================================================
// Istatistikler (Statistics)
// ============================================================================

/// LoRa modulu calisma istatistikleri
///
/// Izleme ve teshis amaciyla paket sayaclari ve hata metrikleri.
/// MQTT uzerinden telemetri olarak raporlanir.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LoRaStats {
    /// Aktif oturum sayisi (basariyla join olmus cihazlar)
    pub active_sessions: u64,
    /// Toplam alinan paket sayisi (CRC hatali dahil)
    pub packets_received: u64,
    /// Toplam gonderilen paket sayisi (downlink)
    pub packets_sent: u64,
    /// Join-request sayisi (basarili + basarisiz)
    pub join_requests: u64,
    /// Islenen uplink paket sayisi (MIC dogrulama basarili)
    pub uplinks_processed: u64,
    /// CRC hatali paket sayisi - yuksekse RF ortami sorunlu olabilir
    pub crc_errors: u64,
    /// Bilinmeyen DevAddr ile gelen paketler - kayitli olmayan cihazlar
    pub unknown_devices: u64,
    /// Join storm korumasi nedeniyle reddedilen join-request sayisi (mevcut periyot)
    #[serde(default)]
    pub join_storm_rejects: u64,
    /// Frame-counter replay korumasi nedeniyle reddedilen uplink sayisi
    /// (EDGE-HIGH-017). FR6 timely-response telemetri sinyali — replay
    /// denemelerini gozlemlenebilir kilar.
    #[serde(default)]
    pub replay_rejects: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dev_eui_display_and_parse() {
        let eui = DevEui([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
        assert_eq!(format!("{}", eui), "0102030405060708");

        let parsed = DevEui::from_hex("0102030405060708").expect("parse basarili olmali");
        assert_eq!(eui, parsed);
    }

    #[test]
    fn test_app_key_masked_display() {
        let key = AppKey([
            0xAA, 0xBB, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0xCC, 0xDD,
        ]);
        let display = format!("{}", key);
        assert_eq!(display, "AABB..CCDD");
    }

    #[test]
    fn test_dev_addr_u32_roundtrip() {
        let addr = DevAddr::from_u32(0x26011234);
        assert_eq!(addr.to_u32(), 0x26011234);
        assert_eq!(format!("{}", addr), "26011234");
    }

    #[test]
    fn test_dev_eui_invalid_hex_length() {
        assert!(DevEui::from_hex("0102").is_err());
        assert!(DevEui::from_hex("ZZZZZZZZZZZZZZZZ").is_err());
    }

    #[test]
    fn test_codec_type_serde() {
        let codec = CodecType::CayenneLpp;
        let json = serde_json::to_string(&codec).expect("serialize basarili olmali");
        assert!(json.contains("cayenne_lpp"));

        let raw = CodecType::RawBinary {
            byte_order: ByteOrder::BigEndian,
        };
        let json = serde_json::to_string(&raw).expect("serialize basarili olmali");
        assert!(json.contains("raw_binary"));
    }
}
