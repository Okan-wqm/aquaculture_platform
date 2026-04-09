# Package 12: platform-crypto-salt-gcm-aad

## Metadata
Status: PENDING
Estimated Tokens: 22K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Closing-Findings: [PLAT-HIGH-001, PLAT-HIGH-002, PLAT-HIGH-003]
Source-Reviews:
  - docs/reviews/platform-services/2026-04-05-s2-high-findings.md

## Context
Config-service EncryptionService has three compounding cryptographic weaknesses: (1) scrypt salt derived from master key (defeats salt purpose), (2) GCM IV is 16 bytes instead of the required 12 bytes (NIST SP 800-38D specifies 96-bit IV for AES-GCM), (3) no AAD binding to tenant context (ciphertext can be moved between tenants without detection).

## Findings

**PLAT-HIGH-001** (platform-services, HIGH)
File: apps/config-service/src/configuration/services/encryption.service.ts (lines 37-39)
scrypt salt derived deterministically from master key via SHA-256 hash. Defeats salt purpose -- enables precomputation attacks. Staging environments may use human-memorable master keys.

**PLAT-HIGH-002** (platform-services, HIGH)
File: apps/config-service/src/configuration/services/encryption.service.ts
GCM IV generated as 16 bytes. AES-256-GCM per NIST SP 800-38D requires 96-bit (12-byte) IV. 16-byte IV triggers internal GCM GHASH IV processing which is less secure than direct 96-bit IV.

**PLAT-HIGH-003** (platform-services, HIGH)
File: apps/config-service/src/configuration/services/encryption.service.ts
No Additional Authenticated Data (AAD) binding to tenantId or configKey. Ciphertext from tenant A can be copied to tenant B's config row and will decrypt successfully. No cryptographic integrity binding between encrypted value and its storage context.

## Affected Files
- apps/config-service/src/configuration/services/encryption.service.ts
- apps/config-service/src/configuration/entities/configuration.entity.ts (potential salt column)

## Dependencies
None. Requires migration for salt storage if using random per-secret salt approach.

## Atomic Commit Plan
```
security(config): fix scrypt salt derivation, correct GCM IV to 12 bytes, add AAD binding

EncryptionService derives scrypt salt from master key (defeats precomputation
resistance), uses 16-byte GCM IV (NIST requires 12), and has no AAD binding
to tenant context (ciphertext relocatable across tenants).

Generate random 32-byte salt per encryption, store alongside ciphertext in
ENC_V2 payload format. Correct IV to 12 bytes. Add tenantId+configKey as
AAD to AES-GCM. Maintain ENC_V1 decrypt-only backward compatibility with
re-encryption on read.

BREAKING CHANGE: Encrypted config value format changes from ENC_V1 to ENC_V2.
Existing values auto-upgrade on next read.

Plan: docs/plans/2026-04-09-high-fixes/packages/12-platform-crypto-salt-gcm-aad.md
Closes: docs/reviews/platform-services/2026-04-05-s2-high-findings.md#H-02
Closes: docs/reviews/platform-services/2026-04-05-s2-high-findings.md#PLAT-HIGH-002
Closes: docs/reviews/platform-services/2026-04-05-s2-high-findings.md#PLAT-HIGH-003
```

## Test Plan
- Unit test: new encryption uses random salt (two encryptions of same value produce different salt)
- Unit test: IV is exactly 12 bytes
- Unit test: decryption fails when AAD (tenantId) mismatches
- Unit test: ENC_V1 values still decrypt correctly (backward compat)
- Unit test: ENC_V1 values are re-encrypted as ENC_V2 on read

## Verification Command
`npx tsc --noEmit -p apps/config-service/tsconfig.json && npx jest --testPathPattern="apps/config-service/src/configuration" --coverage=false`
[Dispatch: security-reviewer]

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
