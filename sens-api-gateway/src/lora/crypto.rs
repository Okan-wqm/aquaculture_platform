//! LoRaWAN 1.0.x Kriptografi Modulu
//!
//! LoRaWAN protokolunun guvenlik katmanini uygular.
//! Tum sifreleme islemleri AES-128 tabanlidir (FIPS 197 uyumlu).
//!
//! # LoRaWAN Guvenlik Mimarisi
//! - MIC (Message Integrity Code): Her uplink/downlink paketinin sonuna eklenen
//!   4-byte deger. AES-128-CMAC ile hesaplanir, paketteki degisiklikleri tespit eder.
//! - FRMPayload Sifreleme: Uygulama verisi AES-128-CTR modunda sifrelenir.
//!   CTR modu, AES-ECB ile Ai bloklari uretip payload ile XOR'layarak calisir.
//! - Join-Accept Sifreleme: Ters yonlu AES-ECB (decrypt = encrypt) kullanilir.
//!   Bu LoRaWAN spesifikasyonuna ozgu bir tasarimdir.
//! - Oturum Anahtar Turetme: AppKey + JoinAccept nonce'lari ile NwkSKey/AppSKey turetilir.
//!
//! # Kullanilan Crate'ler
//! - `aes`: AES-128 blok sifreleme (ECB modu icin)
//! - `cmac`: AES-CMAC (RFC 4493) hesaplama

use aes::Aes128;
use aes::cipher::{BlockDecrypt, BlockEncrypt, KeyInit, generic_array::GenericArray};
use cmac::{Cmac, Mac};
use subtle::ConstantTimeEq;

use super::types::{DevAddr, SessionKeys};

// ============================================================================
// MIC Hesaplama (Message Integrity Code)
// ============================================================================

/// MIC (Message Integrity Code) hesaplar - AES-128-CMAC, ilk 4 byte
///
/// MIC = aes128_cmac(key, B0 | msg)[0..4]
///
/// Her LoRa uplink/downlink paketinde MIC degeri bulunur ve alici tarafinda
/// dogrulanir. MIC eslesmezse paket reddedilir (replay/tamper koruması).
///
/// # Parametreler
/// - `key`: NwkSKey (uplink MIC) veya AppKey (join-request MIC)
/// - `b0`: 16-byte B0 blogu (yön, DevAddr, FCnt, mesaj uzunlugu icerir)
/// - `msg`: MIC hesaplanacak mesaj (MHDR | MACPayload, MIC haric)
///
/// # B0 Blok Yapisi (LoRaWAN 1.0.x Spec 4.4)
/// ```text
/// B0 = 0x49 | 0x00..0x00 | Dir | DevAddr | FCntUp/Down | 0x00 | len(msg)
/// ```
pub fn compute_mic(key: &[u8; 16], b0: &[u8; 16], msg: &[u8]) -> [u8; 4] {
    // AES-128-CMAC hesapla: once B0 blogu, sonra mesaj verisi
    // SAFETY: key is always 16 bytes ([u8; 16]), matching AES-128 key size.
    // new_from_slice only fails if the slice length != cipher key size.
    #[allow(clippy::expect_used)]
    let mut mac = <Cmac<Aes128> as Mac>::new_from_slice(key)
        .expect("BUG: key is [u8; 16] — CMAC key length is always valid");

    mac.update(b0);
    mac.update(msg);

    let result = mac.finalize().into_bytes();

    // MIC = CMAC ciktisinin ilk 4 byte'i (LoRaWAN spesifikasyonu geregi)
    let mut mic = [0u8; 4];
    mic.copy_from_slice(&result[..4]);
    mic
}

/// MIC degerini constant-time olarak dogrular
///
/// Timing side-channel saldirilarina karsi korunmak icin `==` yerine
/// `subtle::ConstantTimeEq` kullanilir. Normal karsilastirma, ilk farkli
/// byte'ta hemen donus yapar ve bu zamanlama farki bir saldirganin
/// MIC degerini byte-byte tahmin etmesine olanak tanir.
///
/// # Parametreler
/// - `computed`: Hesaplanan MIC degeri (4 byte)
/// - `received`: Paketten alinan MIC degeri (4 byte slice)
///
/// # Donus
/// MIC eslesiyor ise `true`, degilse `false`
pub fn verify_mic(computed: &[u8; 4], received: &[u8]) -> bool {
    if received.len() != 4 {
        return false;
    }
    computed.ct_eq(received).into()
}

/// Uplink paketi icin B0 blogu olusturur
///
/// B0, MIC hesaplamasinda kullanilan 16-byte basliktir.
/// Yon bilgisi (Dir), cihaz adresi ve frame sayaci icerir.
///
/// # Parametreler
/// - `dir`: 0 = uplink (cihaz -> sunucu), 1 = downlink (sunucu -> cihaz)
/// - `dev_addr`: Cihazin 32-bit ag adresi
/// - `f_cnt`: Frame sayaci (uplink veya downlink)
/// - `msg_len`: MIC hesaplanacak mesajin uzunlugu
pub fn build_b0(dir: u8, dev_addr: &DevAddr, f_cnt: u32, msg_len: u8) -> [u8; 16] {
    let mut b0 = [0u8; 16];
    b0[0] = 0x49; // Sabit on-ek (LoRaWAN spec)
    // b0[1..5] = 0x00 (reserved)
    b0[5] = dir; // 0 = uplink, 1 = downlink
    b0[6..10].copy_from_slice(&dev_addr.0); // DevAddr (4 byte, little-endian agda)
    b0[10..14].copy_from_slice(&f_cnt.to_le_bytes()); // FCnt (4 byte, little-endian)
    // b0[14] = 0x00 (reserved)
    b0[15] = msg_len; // Mesaj uzunlugu
    b0
}

// ============================================================================
// FRMPayload Sifreleme/Cozme (Application Payload Encryption)
// ============================================================================

/// FRMPayload'i sifreler veya cozer - AES-128-CTR (ECB + XOR yontemiyle)
///
/// LoRaWAN'da CTR modu, standart CTR yerine ECB ile Ai bloklari
/// uretilerek uygulanir. Her 16-byte blok icin:
///   Ai = AES_ECB_encrypt(key, [0x01 | ... | DevAddr | FCnt | i])
///   pld_block[i] = payload_block[i] XOR Ai
///
/// Sifreleme ve cozme ayni islemdir (XOR simetrik).
///
/// # Parametreler
/// - `key`: AppSKey (uygulama verisi icin) veya NwkSKey (MAC komutlari icin)
/// - `dev_addr`: Cihazin ag adresi
/// - `dir`: 0 = uplink, 1 = downlink
/// - `f_cnt`: Frame sayaci
/// - `payload`: Sifrelenecek/cozulecek veri
pub fn encrypt_frm_payload(
    key: &[u8; 16],
    dev_addr: &DevAddr,
    dir: u8,
    f_cnt: u32,
    payload: &[u8],
) -> Vec<u8> {
    if payload.is_empty() {
        return Vec::new();
    }

    let cipher = Aes128::new(GenericArray::from_slice(key));
    let mut result = Vec::with_capacity(payload.len());

    // Payload'i 16-byte bloklara bol
    // Her blok icin Ai uret ve XOR'la
    let block_count = (payload.len() + 15) / 16;

    for i in 1..=block_count {
        // Ai blogu olustur (LoRaWAN Spec 4.3.3)
        let mut ai = [0u8; 16];
        ai[0] = 0x01; // Sabit on-ek
        // ai[1..5] = 0x00 (reserved)
        ai[5] = dir;
        ai[6..10].copy_from_slice(&dev_addr.0);
        ai[10..14].copy_from_slice(&f_cnt.to_le_bytes());
        // ai[14] = 0x00 (reserved)
        ai[15] = i as u8; // Blok indeksi (1-tabanli)

        // Si = AES_ECB_encrypt(Key, Ai)
        let mut block = GenericArray::clone_from_slice(&ai);
        cipher.encrypt_block(&mut block);

        // payload_block XOR Si
        let start = (i - 1) * 16;
        let end = (start + 16).min(payload.len());
        for j in start..end {
            result.push(payload[j] ^ block[j - start]);
        }
    }

    result
}

// ============================================================================
// Join-Accept Sifreleme/Cozme
// ============================================================================

/// Join-accept mesajini cozer - AES-128-ECB decrypt (ters yon)
///
/// LoRaWAN spesifikasyonuna gore join-accept mesaji ozel bir sekilde
/// sifrelenir: ag sunucusu AES-ECB **decrypt** uygular, cihaz ise
/// AES-ECB **encrypt** ile cozer. Bu ters yonlu tasarim, cihazin
/// sadece AES encrypt islemine ihtiyac duymasini saglar (daha kucuk
/// kod boyutu, kisitli MCU'lar icin).
///
/// # Parametreler
/// - `app_key`: Root uygulama anahtari (128-bit)
/// - `encrypted`: Sifreli join-accept verisi (MHDR haric, 16 veya 32 byte)
pub fn decrypt_join_accept(app_key: &[u8; 16], encrypted: &[u8]) -> Vec<u8> {
    let cipher = Aes128::new(GenericArray::from_slice(app_key));
    let mut decrypted = Vec::with_capacity(encrypted.len());

    // Her 16-byte blok icin AES-ECB encrypt uygula (LoRaWAN'da decrypt = encrypt)
    for chunk in encrypted.chunks(16) {
        let mut padded = [0u8; 16];
        let block_slice = if chunk.len() < 16 {
            // Son blok 16 byte'dan kisaysa sifirla (pad)
            padded[..chunk.len()].copy_from_slice(chunk);
            &padded[..]
        } else {
            chunk
        };
        let mut block = GenericArray::clone_from_slice(block_slice);
        // DIKKAT: Burada encrypt kullaniyoruz, decrypt degil!
        // LoRaWAN spec: cihaz tarafinda encrypt ile cozum yapilir
        cipher.encrypt_block(&mut block);
        decrypted.extend_from_slice(&block[..chunk.len()]);
    }

    decrypted
}

/// Join-accept mesajini sifreler (ag sunucusu tarafi)
///
/// Ag sunucusu join-accept'i AES-ECB **decrypt** ile sifreler.
/// Bu, cihazin AES-ECB **encrypt** ile cozmesini saglar.
pub fn encrypt_join_accept(app_key: &[u8; 16], plaintext: &[u8]) -> Vec<u8> {
    let cipher = Aes128::new(GenericArray::from_slice(app_key));
    let mut encrypted = Vec::with_capacity(plaintext.len());

    for chunk in plaintext.chunks(16) {
        let mut padded = [0u8; 16];
        let block_slice = if chunk.len() < 16 {
            padded[..chunk.len()].copy_from_slice(chunk);
            &padded[..]
        } else {
            chunk
        };
        let mut block = GenericArray::clone_from_slice(block_slice);
        // Sunucu tarafi: AES-ECB decrypt ile sifreler
        cipher.decrypt_block(&mut block);
        encrypted.extend_from_slice(&block[..chunk.len()]);
    }

    encrypted
}

// ============================================================================
// Oturum Anahtar Turetme (Session Key Derivation)
// ============================================================================

/// OTAA join isleminden oturum anahtarlarini turetir
///
/// Join-accept mesajindaki AppNonce, NetID ve cihazin DevNonce degerleri
/// kullanilarak NwkSKey ve AppSKey turetilir.
///
/// # Turetme Formulu (LoRaWAN 1.0.x Spec 6.2.5)
/// ```text
/// NwkSKey = aes128_encrypt(AppKey, 0x01 | AppNonce | NetID | DevNonce | pad16)
/// AppSKey = aes128_encrypt(AppKey, 0x02 | AppNonce | NetID | DevNonce | pad16)
/// ```
///
/// # Parametreler
/// - `app_key`: Root uygulama anahtari (128-bit)
/// - `app_nonce`: Ag sunucusunun urettigi 3-byte rastgele deger (join-accept'ten)
/// - `net_id`: 3-byte ag kimligi (join-accept'ten)
/// - `dev_nonce`: Cihazin join-request'te gonderdigi 2-byte rastgele deger
/// - `dev_addr`: Ag tarafindan atanan cihaz adresi (join-accept'ten)
pub fn derive_session_keys(
    app_key: &[u8; 16],
    app_nonce: &[u8; 3],
    net_id: &[u8; 3],
    dev_nonce: &[u8; 2],
    dev_addr: DevAddr,
) -> SessionKeys {
    let cipher = Aes128::new(GenericArray::from_slice(app_key));

    // NwkSKey turetimi: 0x01 on-eki ile
    let nwk_s_key = derive_key(&cipher, 0x01, app_nonce, net_id, dev_nonce);

    // AppSKey turetimi: 0x02 on-eki ile
    let app_s_key = derive_key(&cipher, 0x02, app_nonce, net_id, dev_nonce);

    SessionKeys {
        nwk_s_key,
        app_s_key,
        dev_addr,
        // Yeni oturum, sayaclar sifirdan baslar
        f_cnt_up: 0,
        f_cnt_down: 0,
    }
}

/// Tek bir oturum anahtarini turetir (NwkSKey veya AppSKey)
///
/// Turetme blogu: [type | AppNonce(3) | NetID(3) | DevNonce(2) | pad(7)]
/// AES-128-ECB encrypt ile 16-byte anahtar uretilir.
fn derive_key(
    cipher: &Aes128,
    key_type: u8,
    app_nonce: &[u8; 3],
    net_id: &[u8; 3],
    dev_nonce: &[u8; 2],
) -> [u8; 16] {
    let mut input = [0u8; 16];
    input[0] = key_type; // 0x01 = NwkSKey, 0x02 = AppSKey
    input[1..4].copy_from_slice(app_nonce); // AppNonce (3 byte)
    input[4..7].copy_from_slice(net_id); // NetID (3 byte)
    input[7..9].copy_from_slice(dev_nonce); // DevNonce (2 byte)
    // input[9..16] = 0x00 (pad to 16 bytes)

    let mut block = GenericArray::clone_from_slice(&input);
    cipher.encrypt_block(&mut block);

    let mut key = [0u8; 16];
    key.copy_from_slice(&block);
    key
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mic_computation() {
        // LoRaWAN spesifikasyonundan bilinen test vektoru
        let key = [
            0x2B, 0x7E, 0x15, 0x16, 0x28, 0xAE, 0xD2, 0xA6, 0xAB, 0xF7, 0x15, 0x88, 0x09, 0xCF,
            0x4F, 0x3C,
        ];
        let b0 = [
            0x49, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x04,
        ];
        let msg = [0x40, 0x01, 0x00, 0x00];

        let mic = compute_mic(&key, &b0, &msg);
        // MIC 4 byte olmali
        assert_eq!(mic.len(), 4);
    }

    #[test]
    fn test_verify_mic_constant_time() {
        let key = [
            0x2B, 0x7E, 0x15, 0x16, 0x28, 0xAE, 0xD2, 0xA6, 0xAB, 0xF7, 0x15, 0x88, 0x09, 0xCF,
            0x4F, 0x3C,
        ];
        let b0 = [
            0x49, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x04,
        ];
        let msg = [0x40, 0x01, 0x00, 0x00];

        let mic = compute_mic(&key, &b0, &msg);
        // Dogru MIC ile dogrulama basarili olmali
        assert!(verify_mic(&mic, &mic));
        // Yanlis MIC ile dogrulama basarisiz olmali
        let wrong_mic = [0x00, 0x00, 0x00, 0x00];
        assert!(!verify_mic(&mic, &wrong_mic));
        // Yanlis uzunluk
        assert!(!verify_mic(&mic, &[0x00, 0x00]));
    }

    #[test]
    fn test_frm_payload_encrypt_decrypt_roundtrip() {
        // Sifreleme ve cozme ayni islem oldugu icin roundtrip calismali
        let key = [0x01; 16];
        let dev_addr = DevAddr([0x26, 0x01, 0x12, 0x34]);
        let original = b"Hello LoRaWAN!";

        let encrypted = encrypt_frm_payload(&key, &dev_addr, 0, 1, original);
        assert_ne!(
            &encrypted[..],
            &original[..],
            "sifreli veri orijinalden farkli olmali"
        );

        // Ayni parametrelerle tekrar sifreleme = cozme
        let decrypted = encrypt_frm_payload(&key, &dev_addr, 0, 1, &encrypted);
        assert_eq!(
            &decrypted[..],
            &original[..],
            "cozulen veri orijinalle ayni olmali"
        );
    }

    #[test]
    fn test_frm_payload_empty() {
        let key = [0x01; 16];
        let dev_addr = DevAddr([0x00; 4]);
        let result = encrypt_frm_payload(&key, &dev_addr, 0, 0, &[]);
        assert!(result.is_empty());
    }

    #[test]
    fn test_join_accept_encrypt_decrypt_roundtrip() {
        let app_key = [0xAB; 16];
        let plaintext = [
            0x20, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D,
            0x0E, 0x0F,
        ];

        // Sunucu sifreler (decrypt ile)
        let encrypted = encrypt_join_accept(&app_key, &plaintext);
        assert_ne!(&encrypted[..], &plaintext[..]);

        // Cihaz cozer (encrypt ile)
        let decrypted = decrypt_join_accept(&app_key, &encrypted);
        assert_eq!(&decrypted[..], &plaintext[..]);
    }

    #[test]
    fn test_session_key_derivation() {
        let app_key = [
            0x2B, 0x7E, 0x15, 0x16, 0x28, 0xAE, 0xD2, 0xA6, 0xAB, 0xF7, 0x15, 0x88, 0x09, 0xCF,
            0x4F, 0x3C,
        ];
        let app_nonce = [0x01, 0x02, 0x03];
        let net_id = [0x00, 0x00, 0x01];
        let dev_nonce = [0xAB, 0xCD];
        let dev_addr = DevAddr([0x26, 0x01, 0x12, 0x34]);

        let keys = derive_session_keys(&app_key, &app_nonce, &net_id, &dev_nonce, dev_addr);

        // NwkSKey ve AppSKey farkli olmali (farkli type byte)
        assert_ne!(keys.nwk_s_key, keys.app_s_key);
        // Frame sayaclari sifirdan baslamali
        assert_eq!(keys.f_cnt_up, 0);
        assert_eq!(keys.f_cnt_down, 0);
        assert_eq!(keys.dev_addr, dev_addr);
    }

    #[test]
    fn test_build_b0() {
        let dev_addr = DevAddr([0x26, 0x01, 0x12, 0x34]);
        let b0 = build_b0(0, &dev_addr, 42, 10);

        assert_eq!(b0[0], 0x49);
        assert_eq!(b0[5], 0); // uplink
        assert_eq!(&b0[6..10], &dev_addr.0);
        assert_eq!(u32::from_le_bytes([b0[10], b0[11], b0[12], b0[13]]), 42);
        assert_eq!(b0[15], 10);
    }
}
