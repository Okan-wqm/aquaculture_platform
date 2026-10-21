//! Verifier key store (statements.json `dsse.key_resolution`, DEC-3.3/3.4).
//!
//! A DSSE keyid resolves to (purpose, epoch, key) from the verifier's own
//! store, never from the statement: the keys pinned in the OS image for the
//! os-image purposes, plus, for bundle-only purposes, the anchors of a bundle
//! that itself verified against the fleet-root pin.

use std::collections::BTreeMap;

use super::encoding::sha256_hex;
use super::registry::Purpose;

/// One resolvable key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyEntry {
    /// Purpose the key is pinned or anchored under.
    pub purpose: Purpose,
    /// Its epoch.
    pub epoch: u16,
    /// Raw 32-byte Ed25519 public key.
    pub raw: [u8; 32],
}

/// keyid → key.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KeyStore {
    entries: BTreeMap<String, KeyEntry>,
}

impl KeyStore {
    /// Builds a store; refuses a second key under one keyid or one
    /// (purpose, epoch) slot.
    pub fn from_entries(entries: impl IntoIterator<Item = KeyEntry>) -> Result<Self, String> {
        let mut store = Self::default();
        for entry in entries {
            store.insert(entry)?;
        }
        Ok(store)
    }

    fn insert(&mut self, entry: KeyEntry) -> Result<(), String> {
        let keyid = sha256_hex(&entry.raw);
        if self
            .entries
            .values()
            .any(|e| e.purpose == entry.purpose && e.epoch == entry.epoch)
        {
            return Err(format!("two keys for {}/{}", entry.purpose, entry.epoch));
        }
        if self.entries.insert(keyid.clone(), entry).is_some() {
            return Err(format!("keyid {keyid} pinned twice"));
        }
        Ok(())
    }

    /// Key for `keyid`.
    pub fn get(&self, keyid: &str) -> Option<&KeyEntry> {
        self.entries.get(keyid)
    }

    /// Every key under `purpose`, by keyid.
    pub fn of_purpose(&self, purpose: Purpose) -> impl Iterator<Item = (&str, &KeyEntry)> {
        self.entries
            .iter()
            .filter(move |(_, e)| e.purpose == purpose)
            .map(|(keyid, e)| (keyid.as_str(), e))
    }

    /// Number of keys.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// No key at all.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// y of the small-order points of edwards25519 (little-endian, the sign bit
/// masked): the encodings of 0, 1, p - 1, the two points of order 8, and the
/// non-canonical encodings p and p + 1 of 0 and 1 (the list of
/// statements.json `dsse.signature_algorithm`; libsodium's
/// `ge25519_has_small_order`).
const SMALL_ORDER_Y: [[u8; 32]; 7] = [
    [0; 32],
    [
        1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0,
    ],
    [
        0x26, 0xe8, 0x95, 0x8f, 0xc2, 0xb2, 0x27, 0xb0, 0x45, 0xc3, 0xf4, 0x89, 0xf2, 0xef, 0x98,
        0xf0, 0xd5, 0xdf, 0xac, 0x05, 0xd3, 0xc6, 0x33, 0x39, 0xb1, 0x38, 0x02, 0x88, 0x6d, 0x53,
        0xfc, 0x05,
    ],
    [
        0xc7, 0x17, 0x6a, 0x70, 0x3d, 0x4d, 0xd8, 0x4f, 0xba, 0x3c, 0x0b, 0x76, 0x0d, 0x10, 0x67,
        0x0f, 0x2a, 0x20, 0x53, 0xfa, 0x2c, 0x39, 0xcc, 0xc6, 0x4e, 0xc7, 0xfd, 0x77, 0x92, 0xac,
        0x03, 0x7a,
    ],
    [
        0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0x7f,
    ],
    [
        0xed, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0x7f,
    ],
    [
        0xee, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0x7f,
    ],
];

/// The sign bit of an encoding is the top bit of its last byte; the rest is y.
fn y_bytes(raw: &[u8; 32]) -> [u8; 32] {
    let mut y = *raw;
    if let Some(last) = y.last_mut() {
        *last &= 0x7f;
    }
    y
}

/// RFC 8032 section 5.1.3: an encoding whose y is not below p = 2^255 - 19 is
/// non-canonical. Only y in [p, 2^255) is, and those are the encodings
/// `ed ff .. ff 7f` and above.
fn is_canonical_point(raw: &[u8; 32]) -> bool {
    let [first, middle @ .., last] = y_bytes(raw);
    !(last == 0x7f && middle.iter().all(|b| *b == 0xff) && first >= 0xed)
}

fn is_small_order(raw: &[u8; 32]) -> bool {
    let y = y_bytes(raw);
    SMALL_ORDER_Y.contains(&y)
}

/// Whether a key store may admit the 32 bytes as an Ed25519 public key
/// (statements.json `dsse.signature_algorithm`): the canonical encoding of a
/// point that is not small-order. ed25519-dalek `verify_strict` refuses a
/// small-order A but does not check the canonicality of A itself, so the
/// contract closes it here, at admission: a bundle anchor that is not
/// admissible is `anchor-invalid` and an OS pin that is not admissible is no
/// pin ([`parse_spki_pem`]). A key that is admissible but not a point of the
/// curve is admitted and never verifies a signature.
pub fn is_admissible_key(raw: &[u8; 32]) -> bool {
    is_canonical_point(raw) && !is_small_order(raw)
}

/// The keys one verification may resolve against.
#[derive(Debug, Clone, Copy)]
pub struct KeyView<'a> {
    /// Keys pinned in the OS image.
    pub os: &'a KeyStore,
    /// Bundle-only anchors of a verified bundle, when the call site has one.
    pub bundle: Option<&'a KeyStore>,
}

impl KeyView<'_> {
    /// Resolves `keyid` (OS pins first, then bundle anchors).
    pub fn get(&self, keyid: &str) -> Option<&KeyEntry> {
        self.os
            .get(keyid)
            .or_else(|| self.bundle.and_then(|b| b.get(keyid)))
    }
}

/// DER prefix of an Ed25519 SubjectPublicKeyInfo.
const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

/// Raw key of a PEM Ed25519 SubjectPublicKeyInfo (statements.json
/// `os_key_pin_layout`).
pub fn parse_spki_pem(text: &str) -> Result<[u8; 32], String> {
    let block = pem::parse(text).map_err(|e| format!("not a PEM block: {e}"))?;
    if block.tag() != "PUBLIC KEY" {
        return Err(format!("PEM block is {:?}, not PUBLIC KEY", block.tag()));
    }
    let raw = block
        .contents()
        .strip_prefix(&ED25519_SPKI_PREFIX[..])
        .ok_or("not an Ed25519 SubjectPublicKeyInfo")?;
    let raw = <[u8; 32]>::try_from(raw).map_err(|_| "Ed25519 key is not 32 bytes".to_owned())?;
    if !is_admissible_key(&raw) {
        return Err(
            "Ed25519 key is not admissible (non-canonical or small-order point)".to_owned(),
        );
    }
    Ok(raw)
}

/// Epoch of a pin file name: `<epoch>.pub` with a decimal epoch in
/// 1..=65535 and no leading zero.
pub fn parse_pin_epoch(name: &str) -> Option<u16> {
    let digits = name.strip_suffix(".pub")?;
    let ok = match digits.as_bytes() {
        [b'1'..=b'9', rest @ ..] => rest.iter().all(u8::is_ascii_digit),
        _ => false,
    };
    if ok { digits.parse().ok() } else { None }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_refuses_duplicate_slots_and_keys() {
        let a = KeyEntry {
            purpose: Purpose::FleetRoot,
            epoch: 1,
            raw: [1; 32],
        };
        let same_slot = KeyEntry {
            raw: [2; 32],
            ..a.clone()
        };
        let same_key = KeyEntry {
            epoch: 2,
            ..a.clone()
        };
        assert!(KeyStore::from_entries([a.clone(), same_slot]).is_err());
        assert!(KeyStore::from_entries([a.clone(), same_key]).is_err());
        let store = KeyStore::from_entries([a.clone()]).unwrap_or_default();
        assert_eq!(store.get(&sha256_hex(&a.raw)), Some(&a));
    }

    #[test]
    fn pin_epochs_are_strict() {
        assert_eq!(parse_pin_epoch("1.pub"), Some(1));
        assert_eq!(parse_pin_epoch("65535.pub"), Some(65535));
        for bad in ["01.pub", "0.pub", "65536.pub", "1.pem", "x.pub", ".pub"] {
            assert_eq!(parse_pin_epoch(bad), None, "{bad}");
        }
    }

    /// The Ed25519 base point: a full-order point in canonical form.
    const BASE_POINT: [u8; 32] = [
        0x58, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
        0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
        0x66, 0x66,
    ];

    fn spki_pem(key: &[u8]) -> String {
        let mut der = ED25519_SPKI_PREFIX.to_vec();
        der.extend_from_slice(key);
        pem::encode(&pem::Pem::new("PUBLIC KEY", der))
    }

    #[test]
    fn spki_pem_round_trip() {
        assert_eq!(parse_spki_pem(&spki_pem(&BASE_POINT)), Ok(BASE_POINT));
        let wrong = pem::encode(&pem::Pem::new("CERTIFICATE", vec![0; 44]));
        assert!(parse_spki_pem(&wrong).is_err());
    }

    /// 0xff in every byte but the first and the last.
    fn ff_between(first: u8, last: u8) -> [u8; 32] {
        let mut key = [0xff; 32];
        if let Some(byte) = key.first_mut() {
            *byte = first;
        }
        if let Some(byte) = key.last_mut() {
            *byte = last;
        }
        key
    }

    #[test]
    fn a_pin_that_is_no_admissible_key_is_no_pin() {
        // The non-canonical encoding of the identity, y = p.
        let non_canonical_identity = ff_between(0xed, 0x7f);
        for (what, key) in [
            ("identity", [0u8; 32]),
            ("non-canonical identity (y = p)", non_canonical_identity),
        ] {
            assert!(!is_admissible_key(&key), "{what}");
            assert!(parse_spki_pem(&spki_pem(&key)).is_err(), "{what}");
        }
        assert!(is_admissible_key(&BASE_POINT));
    }

    #[test]
    fn the_small_order_and_canonicality_rules_cover_both_sign_bits() {
        for y in SMALL_ORDER_Y {
            let mut with_sign = y;
            if let Some(last) = with_sign.last_mut() {
                *last |= 0x80;
            }
            assert!(!is_admissible_key(&y));
            assert!(!is_admissible_key(&with_sign));
        }
        // y = p + 3 is non-canonical although it is no small-order point.
        assert!(!is_admissible_key(&ff_between(0xf0, 0x7f)));
        // The sign bit does not make a non-canonical y canonical.
        assert!(!is_admissible_key(&ff_between(0xf0, 0xff)));
        // p - 2 is the largest canonical y that is no small-order point.
        assert!(is_admissible_key(&ff_between(0xeb, 0x7f)));
    }
}
