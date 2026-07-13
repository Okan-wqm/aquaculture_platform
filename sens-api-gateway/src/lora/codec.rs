//! LoRaWAN Payload Codec (Kod Cozucu) Modulu
//!
//! Gelen LoRa payload'larini anlamli sensor degerlerine donusturur.
//! Her cihaz ureticisi farkli bir payload formati kullanabilir;
//! bu modul en yaygin formatlari destekler.
//!
//! # Desteklenen Formatlar
//! - **Cayenne LPP**: The Things Network ve bircok cihaz tarafindan kullanilan
//!   standart format. TLV (Type-Length-Value) yapisindadir.
//! - **Raw Binary**: Her 4 byte'i f32 olarak okuyan basit format.
//! - **Custom**: Cihaz ureticisine ozel decoder (ileride genisletilecek).
//!
//! # Cikti Formati
//! Her decoder `Vec<(String, f64)>` dondurur:
//! - String: Tag adi (orn: "lora_sensor1_temperature")
//! - f64: Olculen deger (muhendislik birimi cinsinden)

use tracing::warn;

use super::types::{ByteOrder, CodecType};

// ============================================================================
// Cayenne LPP Decoder
// ============================================================================

/// Cayenne LPP (Low Power Payload) formatini cozer
///
/// Cayenne LPP, IPSO Smart Object standartlarindan turetilmistir.
/// Her veri noktasi: [channel(1 byte) | type(1 byte) | value(N byte)] seklindedir.
///
/// # Desteklenen Sensor Tipleri
/// - 0x01: Digital Input (1 byte, 0 veya 1)
/// - 0x02: Analog Input (2 byte, signed, olcek: 0.01)
/// - 0x65: Illuminance (2 byte, unsigned, olcek: 1 lux)
/// - 0x67: Temperature (2 byte, signed, olcek: 0.1 C)
/// - 0x68: Relative Humidity (1 byte, unsigned, olcek: 0.5 %)
/// - 0x73: Barometric Pressure (2 byte, unsigned, olcek: 0.1 hPa)
///
/// # Parametreler
/// - `payload`: Ham Cayenne LPP verisi (FRMPayload, sifre cozulmus)
/// - `tag_prefix`: Tag isimlerinin on eki (orn: "lora_dev1_")
///
/// # Ornek
/// Payload `[0x01, 0x67, 0x01, 0x10]`:
/// - Channel 1, Type 0x67 (Temperature), Value 0x0110 = 272 -> 27.2 C
/// - Cikti: ("lora_dev1_ch1_temperature", 27.2)
pub fn decode_cayenne_lpp(payload: &[u8], tag_prefix: &str) -> Vec<(String, f64)> {
    let mut results = Vec::new();
    let mut pos = 0;

    while pos < payload.len() {
        // En az 2 byte gerekli: channel + type
        if pos + 2 > payload.len() {
            warn!(
                "Cayenne LPP: Eksik veri, pos={}, payload_len={}, decode durduruluyor",
                pos,
                payload.len()
            );
            break;
        }

        let channel = payload[pos];
        let data_type = payload[pos + 1];
        pos += 2;

        // Sensor tipine gore veri uzunlugu ve cozumleme
        match data_type {
            // Digital Input: 1 byte, 0 veya 1
            0x01 => {
                if pos + 1 > payload.len() {
                    warn!(
                        "Cayenne LPP: Digital input icin yeterli veri yok, ch={}",
                        channel
                    );
                    break;
                }
                let value = payload[pos] as f64;
                pos += 1;
                results.push((format!("{}ch{}_digital_input", tag_prefix, channel), value));
            }

            // Analog Input: 2 byte, signed, olcek 0.01
            0x02 => {
                if pos + 2 > payload.len() {
                    warn!(
                        "Cayenne LPP: Analog input icin yeterli veri yok, ch={}",
                        channel
                    );
                    break;
                }
                let raw = i16::from_be_bytes([payload[pos], payload[pos + 1]]);
                pos += 2;
                let value = f64::from(raw) * 0.01;
                results.push((format!("{}ch{}_analog_input", tag_prefix, channel), value));
            }

            // Illuminance: 2 byte, unsigned, olcek 1 lux
            0x65 => {
                if pos + 2 > payload.len() {
                    warn!(
                        "Cayenne LPP: Illuminance icin yeterli veri yok, ch={}",
                        channel
                    );
                    break;
                }
                let raw = u16::from_be_bytes([payload[pos], payload[pos + 1]]);
                pos += 2;
                let value = f64::from(raw); // 1 lux olcek
                results.push((format!("{}ch{}_illuminance", tag_prefix, channel), value));
            }

            // Temperature: 2 byte, signed, olcek 0.1 C
            // En yaygin sensor tipi - sicaklik olcumu
            0x67 => {
                if pos + 2 > payload.len() {
                    warn!(
                        "Cayenne LPP: Temperature icin yeterli veri yok, ch={}",
                        channel
                    );
                    break;
                }
                let raw = i16::from_be_bytes([payload[pos], payload[pos + 1]]);
                pos += 2;
                let value = f64::from(raw) * 0.1;
                results.push((format!("{}ch{}_temperature", tag_prefix, channel), value));
            }

            // Relative Humidity: 1 byte, unsigned, olcek 0.5 %
            0x68 => {
                if pos + 1 > payload.len() {
                    warn!(
                        "Cayenne LPP: Humidity icin yeterli veri yok, ch={}",
                        channel
                    );
                    break;
                }
                let raw = payload[pos];
                pos += 1;
                let value = f64::from(raw) * 0.5;
                results.push((format!("{}ch{}_humidity", tag_prefix, channel), value));
            }

            // Barometric Pressure: 2 byte, unsigned, olcek 0.1 hPa
            0x73 => {
                if pos + 2 > payload.len() {
                    warn!(
                        "Cayenne LPP: Barometric icin yeterli veri yok, ch={}",
                        channel
                    );
                    break;
                }
                let raw = u16::from_be_bytes([payload[pos], payload[pos + 1]]);
                pos += 2;
                let value = f64::from(raw) * 0.1;
                results.push((
                    format!("{}ch{}_barometric_pressure", tag_prefix, channel),
                    value,
                ));
            }

            // Bilinmeyen tip - atla
            unknown => {
                // Bilinmeyen tiplerin veri boyutunu bilmedigimiz icin
                // geri kalan payload'i guvenli sekilde atlayamayiz
                warn!(
                    "Cayenne LPP: Bilinmeyen sensor tipi 0x{:02X}, ch={}, kalan veri atlanıyor",
                    unknown, channel
                );
                break;
            }
        }
    }

    results
}

// ============================================================================
// Raw Binary Decoder
// ============================================================================

/// Ham binary payload'i cozer - her 4 byte bir f32 degeri
///
/// Bazi basit cihazlar, sensor degerlerini sirayla f32 olarak gonderir.
/// Bu decoder payload'i 4-byte bloklara bolup her birini f32'ye cevirir.
///
/// # Parametreler
/// - `payload`: Ham binary veri (FRMPayload, sifre cozulmus)
/// - `tag_prefix`: Tag isimlerinin on eki
/// - `byte_order`: Byte sirasi (big-endian veya little-endian)
///
/// # Tag Isimlendirme
/// Degerler sirayla: `{prefix}raw_0`, `{prefix}raw_1`, ... seklinde isimlendirilir.
pub fn decode_raw_binary(
    payload: &[u8],
    tag_prefix: &str,
    byte_order: ByteOrder,
) -> Vec<(String, f64)> {
    let mut results = Vec::new();

    // Payload 4'un kati degilse kalan byte'lar atlanir
    if payload.len() % 4 != 0 {
        warn!(
            "Raw binary: Payload uzunlugu ({}) 4'un kati degil, kalan {} byte atlanacak",
            payload.len(),
            payload.len() % 4
        );
    }

    for (i, chunk) in payload.chunks_exact(4).enumerate() {
        let bytes: [u8; 4] = [chunk[0], chunk[1], chunk[2], chunk[3]];

        let value = match byte_order {
            ByteOrder::BigEndian => f32::from_be_bytes(bytes),
            ByteOrder::LittleEndian => f32::from_le_bytes(bytes),
        };

        // NaN ve Infinity kontrolu - bozuk veriyi filtrele
        if value.is_finite() {
            results.push((format!("{}raw_{}", tag_prefix, i), f64::from(value)));
        } else {
            warn!(
                "Raw binary: Index {} degerinde gecersiz float (NaN/Inf), atlaniyor",
                i
            );
        }
    }

    results
}

// ============================================================================
// Dispatcher (Ana Codec Yonlendiricisi)
// ============================================================================

/// Payload'i yapilandirmadaki codec turune gore cozer
///
/// LoRaDeviceConfig'teki codec alanina bakar ve uygun decoder'i cagirir.
/// Bu fonksiyon, uplink isleme boru hattinda ana giris noktasidir.
///
/// # Parametreler
/// - `payload`: Sifre cozulmus FRMPayload verisi
/// - `tag_prefix`: Tag isimlendirme on eki
/// - `codec_type`: Kullanilacak codec turu (cihaz config'inden gelir)
pub fn decode_payload(
    payload: &[u8],
    tag_prefix: &str,
    codec_type: &CodecType,
) -> Vec<(String, f64)> {
    match codec_type {
        CodecType::CayenneLpp => decode_cayenne_lpp(payload, tag_prefix),
        CodecType::RawBinary { byte_order } => decode_raw_binary(payload, tag_prefix, *byte_order),
        CodecType::Custom { decoder_name } => {
            // Sandboxed wasm decoder plugin (ADR-026 follow-on). With the
            // `wasm-codec` feature the named decoder runs in a fuel- and
            // memory-bounded wasmi isolate; without it, custom codecs remain a
            // warn+empty no-op so the default fleet binary carries no wasm engine.
            #[cfg(feature = "wasm-codec")]
            {
                super::wasm_decoder::decode(decoder_name, payload, tag_prefix)
            }
            #[cfg(not(feature = "wasm-codec"))]
            {
                warn!(
                    "Custom codec '{}' desteklenmiyor (wasm-codec feature kapali), bos sonuc donuluyor",
                    decoder_name
                );
                Vec::new()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cayenne_lpp_temperature() {
        // Channel 1, Temperature (0x67), 27.2 C = 272 = 0x0110
        let payload = [0x01, 0x67, 0x01, 0x10];
        let results = decode_cayenne_lpp(&payload, "dev1_");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, "dev1_ch1_temperature");
        assert!((results[0].1 - 27.2).abs() < 0.01);
    }

    #[test]
    fn test_cayenne_lpp_negative_temperature() {
        // Channel 2, Temperature, -10.5 C = -105 = 0xFF97
        let payload = [0x02, 0x67, 0xFF, 0x97];
        let results = decode_cayenne_lpp(&payload, "test_");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, "test_ch2_temperature");
        assert!((results[0].1 - (-10.5)).abs() < 0.01);
    }

    #[test]
    fn test_cayenne_lpp_humidity() {
        // Channel 1, Humidity (0x68), 50.0% = 100 = 0x64
        let payload = [0x01, 0x68, 0x64];
        let results = decode_cayenne_lpp(&payload, "h_");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, "h_ch1_humidity");
        assert!((results[0].1 - 50.0).abs() < 0.01);
    }

    #[test]
    fn test_cayenne_lpp_barometric_pressure() {
        // Channel 1, Barometric (0x73), 1013.25 hPa = 10132 = 0x2794
        // Not: 0.1 hPa olcek, 10132 * 0.1 = 1013.2
        let payload = [0x01, 0x73, 0x27, 0x94];
        let results = decode_cayenne_lpp(&payload, "bp_");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, "bp_ch1_barometric_pressure");
        assert!((results[0].1 - 1013.2).abs() < 0.1);
    }

    #[test]
    fn test_cayenne_lpp_digital_input() {
        // Channel 3, Digital Input (0x01), value = 1
        let payload = [0x03, 0x01, 0x01];
        let results = decode_cayenne_lpp(&payload, "d_");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, "d_ch3_digital_input");
        assert!((results[0].1 - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_cayenne_lpp_analog_input() {
        // Channel 1, Analog Input (0x02), 12.34 = 1234 = 0x04D2
        let payload = [0x01, 0x02, 0x04, 0xD2];
        let results = decode_cayenne_lpp(&payload, "a_");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, "a_ch1_analog_input");
        assert!((results[0].1 - 12.34).abs() < 0.01);
    }

    #[test]
    fn test_cayenne_lpp_illuminance() {
        // Channel 1, Illuminance (0x65), 500 lux = 0x01F4
        let payload = [0x01, 0x65, 0x01, 0xF4];
        let results = decode_cayenne_lpp(&payload, "l_");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, "l_ch1_illuminance");
        assert!((results[0].1 - 500.0).abs() < 0.01);
    }

    #[test]
    fn test_cayenne_lpp_multi_sensor() {
        // Birden fazla sensor: Temp 25.0C + Humidity 65%
        let payload = [
            0x01, 0x67, 0x00, 0xFA, // Ch1, Temp, 250 -> 25.0 C
            0x02, 0x68, 0x82, // Ch2, Hum, 130 -> 65.0 %
        ];
        let results = decode_cayenne_lpp(&payload, "multi_");

        assert_eq!(results.len(), 2);
        assert_eq!(results[0].0, "multi_ch1_temperature");
        assert!((results[0].1 - 25.0).abs() < 0.01);
        assert_eq!(results[1].0, "multi_ch2_humidity");
        assert!((results[1].1 - 65.0).abs() < 0.01);
    }

    #[test]
    fn test_cayenne_lpp_empty_payload() {
        let results = decode_cayenne_lpp(&[], "test_");
        assert!(results.is_empty());
    }

    #[test]
    fn test_cayenne_lpp_truncated_payload() {
        // Eksik veri: Temperature tipi ama sadece 1 byte deger
        let payload = [0x01, 0x67, 0x01]; // 2 byte gerekirken 1 byte var
        let results = decode_cayenne_lpp(&payload, "trunc_");
        assert!(results.is_empty()); // Eksik veri yuzunden decode yapilamadi
    }

    #[test]
    fn test_raw_binary_big_endian() {
        // 2 adet f32: 25.5 ve 1013.25
        let mut payload = Vec::new();
        payload.extend_from_slice(&f32::to_be_bytes(25.5));
        payload.extend_from_slice(&f32::to_be_bytes(1013.25));

        let results = decode_raw_binary(&payload, "raw_", ByteOrder::BigEndian);

        assert_eq!(results.len(), 2);
        assert_eq!(results[0].0, "raw_raw_0");
        assert!((results[0].1 - 25.5).abs() < 0.01);
        assert_eq!(results[1].0, "raw_raw_1");
        assert!((results[1].1 - 1013.25).abs() < 0.01);
    }

    #[test]
    fn test_raw_binary_little_endian() {
        let mut payload = Vec::new();
        payload.extend_from_slice(&f32::to_le_bytes(42.0));

        let results = decode_raw_binary(&payload, "le_", ByteOrder::LittleEndian);

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, "le_raw_0");
        assert!((results[0].1 - 42.0).abs() < 0.01);
    }

    #[test]
    fn test_raw_binary_partial_chunk() {
        // 5 byte: ilk 4 byte decode edilir, son 1 byte atlanir
        let mut payload = Vec::new();
        payload.extend_from_slice(&f32::to_be_bytes(10.0));
        payload.push(0xFF);

        let results = decode_raw_binary(&payload, "p_", ByteOrder::BigEndian);
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn test_decode_payload_dispatcher() {
        // Cayenne LPP dispatcher testi
        let payload = [0x01, 0x67, 0x00, 0xFA]; // 25.0 C
        let codec = CodecType::CayenneLpp;
        let results = decode_payload(&payload, "disp_", &codec);

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, "disp_ch1_temperature");
    }

    #[test]
    fn test_decode_payload_custom_returns_empty() {
        let payload = [0x01, 0x02, 0x03];
        let codec = CodecType::Custom {
            decoder_name: "unknown_decoder".to_string(),
        };
        let results = decode_payload(&payload, "c_", &codec);
        assert!(results.is_empty());
    }
}
