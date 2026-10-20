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
    <[u8; 32]>::try_from(raw).map_err(|_| "Ed25519 key is not 32 bytes".to_owned())
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

    #[test]
    fn spki_pem_round_trip() {
        let mut der = ED25519_SPKI_PREFIX.to_vec();
        der.extend_from_slice(&[7; 32]);
        let text = pem::encode(&pem::Pem::new("PUBLIC KEY", der));
        assert_eq!(parse_spki_pem(&text), Ok([7; 32]));
        let wrong = pem::encode(&pem::Pem::new("CERTIFICATE", vec![0; 44]));
        assert!(parse_spki_pem(&wrong).is_err());
    }
}
