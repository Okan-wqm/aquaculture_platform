# Research: MFA TOTP (RFC 6238), AES-GCM Secret Encryption, Recovery Codes

**Date:** 2026-04-08
**Agent:** auth-security-expert
**Topic slug:** mfa-totp-rfc-6238-aes-gcm-recovery-codes

## Sources
- [RFC 6238 — TOTP: Time-Based One-Time Password Algorithm](https://www.rfc-editor.org/rfc/rfc6238.html)
- [RFC 4226 — HOTP: HMAC-Based One-Time Password Algorithm](https://datatracker.ietf.org/doc/html/rfc4226)
- [OWASP Multifactor Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html)
- [OWASP Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [NIST SP 800-63B — Digital Identity Guidelines (Authentication & Lifecycle)](https://pages.nist.gov/800-63-3/sp800-63b.html)
- [NIST SP 800-63B-4 (Draft)](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-63B-4.pdf)

## Key Findings

### RFC 6238 TOTP algorithm
- `TOTP = HOTP(K, T)` where `T = floor((currentTime - T0) / X)`.
- **Default step size X = 30 seconds** (§4.1).
- Secret K SHOULD be >= HMAC output size (20 bytes for SHA-1, 32 for SHA-256).
- Algorithm: HMAC-SHA-1 by default; SHA-256/SHA-512 variants allowed for higher security.
- Code length: 6 digits default, 8 digits allowed.

### Validation window (RFC 6238 §5.2)
- Verifier SHOULD accept ±1 time step for clock drift tolerance (~89 seconds elapsed tolerance).
- Going wider (±2 or more) weakens security and is NOT recommended.
- Verifier MUST track used OTPs within the window to prevent replay (§5.2): "the verifier MUST NOT accept the second attempt of the OTP after the successful validation has been issued for the first OTP."

### One-time use enforcement
- Within a time step, each OTP can be used AT MOST once per user.
- Implementation: store `lastUsedTimeStep` per user; reject if incoming step <= stored value.

### AES-256-GCM secret storage (OWASP Cryptographic Storage Cheat Sheet)
- OWASP: "The most commonly used authenticated modes are GCM and CCM, which should be used as a first preference... select AES-256 using GCM (Galois Counter Mode)."
- TOTP secrets MUST NOT be stored plaintext. Encrypt with AES-256-GCM using a KMS-managed data-encryption key.
- GCM provides authenticated encryption — tampered secrets fail decryption.
- **Nonce uniqueness is critical:** reuse of (key, nonce) with GCM is catastrophic. Use random 96-bit nonce per encryption.
- Store: `{ciphertext, nonce, authTag}` as separate columns or encoded tuple.

### Recovery codes (OWASP MFA Cheat Sheet)
- Generate 8-10 recovery codes per user on MFA enrollment.
- Each code: 10-12 characters from `[A-Z0-9]` (>= 50 bits entropy, use `crypto.randomBytes`).
- **Store SHA-256 hashed** (not bcrypt — recovery codes already have enough entropy; bcrypt's slowness is for low-entropy secrets).
- Mark code as `used` after successful use; never accept twice.
- Display plaintext ONCE during enrollment; never retrievable again.
- Regenerate set invalidates all previous codes.

### MFA lockout (separate from login lockout)
- OWASP: "rate limit / lockout on MFA attempts."
- Recommended: 5 failed TOTP attempts within 15 minutes → lockout.
- Separate counter from login lockout (a user who passed password but fails TOTP should not lock the password counter).
- Generic error message: "Invalid code" (never "code expired" vs "code incorrect" — that aids enumeration).

### NIST SP 800-63B AAL2 requirements
- AAL2 requires multi-factor authentication (memorized secret + something-you-have).
- TOTP qualifies as a single-factor OTP authenticator when combined with a memorized secret.
- SMS OTP is DISCOURAGED ("restricted authenticator" under NIST 800-63B-4).
- Push notification + biometric gesture = preferred next-gen option.

### TOTP enrollment flow
1. Server generates 20-32 random bytes via `crypto.randomBytes`.
2. Server encrypts secret with AES-256-GCM (data key from KMS).
3. Server stores `{ciphertext, nonce, authTag}` + `enabled: false`.
4. Server returns provisioning URI (`otpauth://totp/...?secret=<base32>&issuer=...`).
5. User scans QR code; authenticator app derives codes.
6. User submits confirmation OTP.
7. Server decrypts secret, validates OTP. If valid → `enabled: true`, generate recovery codes.
8. Server returns recovery codes (plaintext, shown once).

## Security Concerns
- **CRITICAL:** TOTP secrets stored plaintext = trivial MFA bypass on DB leak.
- **CRITICAL:** GCM nonce reuse = catastrophic confidentiality loss.
- **CRITICAL:** Missing one-time-use enforcement = OTP replay within 30s window.
- **CRITICAL:** Recovery codes in plaintext = backup bypass of MFA.
- **HIGH:** Validation window > ±1 = weakened security with marginal usability gain.
- **HIGH:** Missing MFA lockout = unlimited TOTP brute force (1 in 1M per attempt).
- **HIGH:** bcrypt-hashed recovery codes = unnecessary slowness without security benefit (SHA-256 sufficient due to entropy).
- **MEDIUM:** SMS OTP enabled = uses a NIST-restricted authenticator.

## Performance Concerns
- TOTP verification: O(window size) HMAC computations. With ±1 window = 3 HMACs = negligible.
- AES-GCM decrypt of TOTP secret: < 1ms. Acceptable on every MFA check.
- Recovery code check: SHA-256 hash + DB lookup = < 1ms.

## Architectural Implications
- KMS-managed data encryption key for TOTP secrets required. Cannot store key in env or source.
- MFA lockout counter independent from login lockout counter (separate Redis keys).
- Recovery code regeneration flow must atomically invalidate old set and issue new.
- MfaService must emit SecurityEvent on enrollment, disable, lockout, recovery-code use.

## Domain Rule Additions
- **CRITICAL:** TOTP secrets MUST be AES-256-GCM encrypted at rest with KMS-managed key. Plaintext storage is CRITICAL.
- **CRITICAL:** AES-GCM nonce MUST be unique per encryption (random 96-bit per call). Nonce reuse is CRITICAL.
- **CRITICAL:** TOTP validation MUST enforce one-time use within the time step (track `lastUsedTimeStep` per user).
- **CRITICAL:** Recovery codes MUST be SHA-256 hashed before DB storage. Plaintext is CRITICAL.
- TOTP time step MUST be 30s, window MUST be ±1 (RFC 6238 §5.2 recommendation).
- 8 recovery codes per user, displayed ONCE at enrollment, regenerable (invalidates prior set).
- MFA lockout: 5 failed attempts / 15 minutes, separate from login lockout counter.
- Generic error "Invalid code" — never distinguish expired/incorrect/replayed.
- TOTP enrollment confirmation required before `mfa_enabled: true` flag.
- SMS OTP is NOT an approved authenticator (NIST SP 800-63B restricted).
