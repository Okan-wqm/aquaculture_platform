//! Lexical forms of the edge contract (schemas/common.schema.json `$defs`).
//!
//! Each predicate is the exact language of one schema pattern; the typed
//! statement parsers call them, so a payload the JSON Schema rejects is
//! `schema-invalid` here too.

use base64::Engine;
use sha2::{Digest as _, Sha256};

/// Lowercase hex of `bytes`.
pub fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        // Writing into a String cannot fail.
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Lowercase hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex_lower(&Sha256::digest(bytes))
}

fn all_bytes(s: &str, ok: impl Fn(u8) -> bool) -> bool {
    s.bytes().all(ok)
}

fn is_lower_hex(b: u8) -> bool {
    b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
}

/// `^[0-9a-f]{64}$` (sha256_hex, keyid).
pub fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && all_bytes(s, is_lower_hex)
}

/// Lowercase canonical RFC 9562 UUID (`uuid`).
pub fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, &c)| match i {
            8 | 13 | 18 | 23 => c == b'-',
            14 => (b'1'..=b'8').contains(&c),
            19 => matches!(c, b'8' | b'9' | b'a' | b'b'),
            _ => is_lower_hex(c),
        })
}

/// Two ASCII digits whose value lies in `range`.
fn two_digits(pair: [u8; 2], range: std::ops::RangeInclusive<u8>) -> bool {
    let [tens, ones] = pair;
    tens.is_ascii_digit()
        && ones.is_ascii_digit()
        && range.contains(&((tens - b'0') * 10 + (ones - b'0')))
}

/// `YYYY-MM-DDTHH:MM:SSZ` with the schema's field ranges (`timestamp`).
/// Timestamps are fixed-width, so their string order is their time order.
pub fn is_timestamp(s: &str) -> bool {
    let Ok(bytes) = <[u8; 20]>::try_from(s.as_bytes()) else {
        return false;
    };
    let [
        y0,
        y1,
        y2,
        y3,
        b'-',
        mo0,
        mo1,
        b'-',
        d0,
        d1,
        b'T',
        h0,
        h1,
        b':',
        mi0,
        mi1,
        b':',
        s0,
        s1,
        b'Z',
    ] = bytes
    else {
        return false;
    };
    [y0, y1, y2, y3].iter().all(u8::is_ascii_digit)
        && two_digits([mo0, mo1], 1..=12)
        && two_digits([d0, d1], 1..=31)
        && two_digits([h0, h1], 0..=23)
        && two_digits([mi0, mi1], 0..=59)
        && two_digits([s0, s1], 0..=59)
}

/// `0|[1-9][0-9]*` without bounds; the value when it fits u64.
fn decimal(s: &str) -> Option<u64> {
    let ok = match s.as_bytes() {
        [] => false,
        [b'0'] => true,
        [b'1'..=b'9', rest @ ..] => rest.iter().all(u8::is_ascii_digit),
        _ => false,
    };
    if ok { s.parse().ok() } else { None }
}

/// `MAJOR.MINOR.PATCH` with decimal integers (`os_version` core); the
/// integer tuple the compatibility rules compare.
pub fn parse_version_core(s: &str) -> Option<(u64, u64, u64)> {
    let mut parts = s.split('.');
    let major = decimal(parts.next()?)?;
    let minor = decimal(parts.next()?)?;
    let patch = decimal(parts.next()?)?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

/// Path-safe semantic version (`semver`, DEC-1.10).
pub fn is_semver(s: &str) -> bool {
    if s.len() > 64 {
        return false;
    }
    let (core, pre) = match s.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (s, None),
    };
    parse_version_core(core).is_some()
        && pre.is_none_or(|pre| {
            pre.split('.').all(|id| {
                !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            })
        })
}

/// `os_version`: version core only, at most 32 characters.
pub fn is_os_version(s: &str) -> bool {
    s.len() <= 32 && parse_version_core(s).is_some()
}

/// Canonical RFC 4648 standard base64 with padding and zero trailing bits
/// (`base64`); the decoded bytes when `s` has that form.
pub fn decode_canonical_base64(s: &str) -> Option<Vec<u8>> {
    // The STANDARD engine requires canonical padding and rejects non-zero
    // trailing bits, which is exactly the schema pattern.
    base64::engine::general_purpose::STANDARD.decode(s).ok()
}

/// Canonical base64 of exactly `N` bytes.
pub fn decode_base64_array<const N: usize>(s: &str) -> Option<[u8; N]> {
    decode_canonical_base64(s)?.try_into().ok()
}

/// `ed25519_public_key`: canonical base64 of a raw 32-byte key.
pub fn is_ed25519_public_key(s: &str) -> bool {
    s.len() == 44 && decode_base64_array::<32>(s).is_some()
}

/// DSSE payloadType form of the envelope schema.
pub fn is_payload_type(s: &str) -> bool {
    let Some(rest) = s
        .strip_prefix("application/vnd.suderra.")
        .and_then(|r| r.strip_suffix("+json"))
    else {
        return false;
    };
    let Some((kind, version)) = rest.rsplit_once(".v") else {
        return false;
    };
    let version_ok = match version.as_bytes() {
        [b'1'..=b'9', rest @ ..] => rest.iter().all(u8::is_ascii_digit),
        _ => false,
    };
    version_ok
        && kind.split('-').all(|w| {
            !w.is_empty() && all_bytes(w, |b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

/// `^CONFIG_[A-Z0-9_]+$`.
pub fn is_kernel_symbol(s: &str) -> bool {
    s.strip_prefix("CONFIG_").is_some_and(|rest| {
        !rest.is_empty()
            && all_bytes(rest, |b| {
                b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'
            })
    })
}

/// RBAC `tag_id`.
pub fn is_tag_id(s: &str) -> bool {
    (1..=128).contains(&s.len())
        && all_bytes(s, |b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
}

/// PEM certificate form of the trust-anchors x509 anchor.
pub fn is_pem_certificate(s: &str) -> bool {
    s.strip_prefix("-----BEGIN CERTIFICATE-----\n")
        .and_then(|r| r.strip_suffix("-----END CERTIFICATE-----\n"))
        .is_some_and(|body| {
            !body.is_empty()
                && all_bytes(body, |b| b.is_ascii_alphanumeric() || b"+/=\n".contains(&b))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_is_path_safe() {
        for ok in ["1.6.0", "0.0.0", "10.20.30", "1.0.0-rc.1", "1.0.0-alpha-1.x"] {
            assert!(is_semver(ok), "{ok}");
        }
        let long = "1".repeat(65);
        for bad in [
            "../../etc",
            "1.6",
            "01.6.0",
            "1.6.0+build",
            "1.6.0-",
            "1.6.0-a..b",
            "1.6.0/x",
            "v1.6.0",
            "",
            long.as_str(),
        ] {
            assert!(!is_semver(bad), "{bad}");
        }
    }

    #[test]
    fn timestamps_and_uuids() {
        assert!(is_timestamp("2026-10-20T12:00:00Z"));
        for bad in [
            "2026-10-20T12:00:00.000Z",
            "2026-10-20T12:00:00+00:00",
            "2026-13-20T12:00:00Z",
            "2026-10-20 12:00:00Z",
            "2026-10-20T24:00:00Z",
            "2026-10-00T12:00:00Z",
        ] {
            assert!(!is_timestamp(bad), "{bad}");
        }
        assert!(is_uuid("7e570000-0000-4000-8000-0000000000d1"));
        assert!(!is_uuid("00000000-0000-0000-0000-000000000000"));
        assert!(!is_uuid("7E570000-0000-4000-8000-0000000000D1"));
    }

    #[test]
    fn base64_must_be_canonical() {
        assert_eq!(decode_canonical_base64("aGVsbG8="), Some(b"hello".to_vec()));
        assert_eq!(decode_canonical_base64("aGVsbG9="), None, "non-zero trailing bits");
        assert_eq!(decode_canonical_base64("aGVsbG8"), None, "missing padding");
        assert_eq!(decode_canonical_base64("aGVs bG8="), None);
    }

    #[test]
    fn payload_types_and_hex() {
        assert!(is_payload_type("application/vnd.suderra.edge-release.v1+json"));
        assert!(!is_payload_type("application/vnd.suderra.edge--release.v1+json"));
        assert!(!is_payload_type("application/vnd.suderra.edge-release.v0+json"));
        assert_eq!(hex_lower(&[0x00, 0xab, 0xff]), "00abff");
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
