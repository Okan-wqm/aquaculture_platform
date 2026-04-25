# Export-Control Classification — Suderra Edge Agent

> **(LEGAL REVIEW REQUIRED — especially customs classification)** — This document records Suderra's self-classification reasoning for export-control purposes. It is CCATS-ready input; it is not a Commodity Classification Automated Tracking System (CCATS) ruling. Counsel must confirm the classification with the relevant export-control authority prior to distribution into a regulated destination.

Document date: 2026-04-24
Export-control reference date: 2026-04-24

---

## 1. Product identification

- **Name:** Suderra Edge Agent (`suderra-agent`)
- **Version:** 1.6.0 and successor minor releases
- **Functional class:** Industrial IoT edge-gateway software; sensor ingestion, protocol bridging, control-logic execution (IEC 61131-3 bytecode VM), tamper-evident audit logging, secure northbound transport.
- **Deliverable form:** Compiled ELF binary for Linux targets (`x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`, `armv7-unknown-linux-gnueabihf`, per `sens-api-gateway/deny.toml:8-12`) plus systemd unit and configuration templates.

---

## 2. Classification

### 2.1 United States Export Administration Regulations (EAR)

**Primary ECCN:** **5D002** — Information security software using cryptographic functionality for confidentiality, authentication, key management, or digital signatures, above the Note 3 ("mass market") threshold in form but addressed by the §740.17(b)(1) licence exception.

**Basis:** The Edge Agent implements:

- Data-in-transit confidentiality via TLS (rustls backend via `reqwest` `rustls-tls-manual-roots` feature; `Cargo.toml:30`).
- MQTT confidentiality via rustls (`rumqttc` 0.25 default rustls backend; `Cargo.toml:34`).
- Data-at-rest confidentiality via AES-256 SQLCipher (`rusqlite` 0.34 `bundled-sqlcipher-vendored-openssl` feature; `Cargo.toml:94`).
- Digital signatures via Ed25519 (`ed25519-dalek` 2.1; `Cargo.toml:145`).
- Key derivation via HKDF-SHA256 (`hkdf` 0.12; `Cargo.toml:158`) and Argon2id (`argon2` 0.5; `Cargo.toml:171`).
- Message-authentication via HMAC-SHA256 (`hmac` 0.12; `Cargo.toml:116`) and AES-CMAC (`cmac` 0.7, LoRaWAN MIC; `Cargo.toml:288`).
- Constant-time comparison for MIC / PIN verification (`subtle` 2; `Cargo.toml:291`).
- Symmetric block cipher AES-128 / AES-256 (`aes` 0.8, LoRaWAN crypto; `Cargo.toml:287`).
- X.509 certificate handling (`x509-parser` 0.16, `pem` 3.0; `Cargo.toml:126-127`).
- JWT verification with Ed25519 (`jsonwebtoken` 9; `Cargo.toml:252`).

All primitives are standard, publicly documented, and implemented via established open-source libraries in their default parameter ranges. No custom cryptographic algorithm is introduced. No cryptanalysis functionality is present. No quantum-cryptography functionality is present. These facts are the basis for Mass Market Exception qualification below (§2.3).

**(LEGAL REVIEW REQUIRED)**

### 2.2 Wassenaar Arrangement correlation

The product falls under the dual-use items List Category 5, Part 2 (information security), specifically item 5.A.2 "systems, equipment, components and software" using cryptographic functionality. The Wassenaar "Cryptography Note" is invoked on the same Mass Market grounds as §2.3.

### 2.3 Mass Market Exception qualification (EAR §740.17(b)(1))

The Edge Agent qualifies as a "mass market" item per the four-part test in §740.17(b)(1):

| Criterion | Status |
|-----------|--------|
| Generally available to the public by sale, without restriction, at retail or through direct-to-customer channels | Satisfied — commercial product, no export-licensee filtering beyond §3 below. |
| Designed for installation by the user without further substantial support | Satisfied — install guide in `../deployment/` intended for typical system integrators. |
| Cryptographic functionality cannot be easily changed by the user | Satisfied — primitives are fixed at build time; no user-exposed algorithm-selection toggles that could substitute a non-standard algorithm; tamper evidence enforced by the signed-deploy feature (`Cargo.toml:355`). |
| Designed for public sector or commercial use, not specifically designed for government | Satisfied — industrial / commercial customers are the primary market; no "government exclusive" features. |

**Self-classification outcome:** The Edge Agent is eligible for export under License Exception ENC, specifically §740.17(b)(1) "mass market", reported annually to BIS as required. Items shipped under this exception are still subject to the anti-terrorism, embargo, and end-use restrictions below.

**(LEGAL REVIEW REQUIRED)** — commodity classification request (CCR) filing to confirm the 5D002 / mass-market status remains advisable prior to a first export into a regulated destination.

### 2.4 EU dual-use

Under EU Regulation 2021/821, the same Wassenaar 5.A.2 classification applies. The Cryptography Note and "mass market" framing as implemented in Annex I Note 3 to Category 5 Part 2 is used as the basis for general authorisation rather than individual licensing. Member-state implementation variances (notably France, Germany) are confirmed by counsel at export time.

**(LEGAL REVIEW REQUIRED)**

### 2.5 United Kingdom

UK Export Control Order 2008 (as amended post-EU-exit) retains the Wassenaar 5.A.2 framing; the UK Open General Export Licence (OGEL) for cryptographic software covers the mass-market case. Counsel confirms current OGEL applicability.

### 2.6 Turkey

Turkish export controls (Ministry of Trade, Dual-Use and Sensitive Items List) mirror the Wassenaar list. Suderra is a Turkish-resident licensor; Turkish-origin exports are subject to the Ministry's periodic list updates. Counsel confirms current list status at export time.

**(LEGAL REVIEW REQUIRED)**

---

## 3. Prohibited destinations

As of the document date, the following destinations are prohibited destinations for the Suderra Edge Agent regardless of exception eligibility, due to comprehensive sanctions, embargoes, or unfavourable end-user concerns:

- **Russian Federation** (EU, US, UK, Turkey posture; 2022-02 sanctions regime, updated 2024 and 2025).
- **Islamic Republic of Iran** (US OFAC, EU, UK; long-standing comprehensive sanctions).
- **Democratic People's Republic of Korea** (UN, US, EU, UK, Turkey; UN Security Council resolution regime).
- **Republic of Cuba** (US; EU / UK / Turkey restrictions less comprehensive but elevated diligence applied).
- **Syrian Arab Republic** (EU, US, UK, Turkey; 2011 sanctions regime, updated).
- **Republic of Belarus** (EU, US, UK post-2020-08; elevated since 2022-02).

Additional destination or end-user restrictions apply to:

- Crimea, Donetsk, Luhansk, Zaporizhzhia, Kherson territories (EU / US / UK regional sanctions).
- Restricted-entity lists: US BIS Entity List, OFAC SDN List, EU consolidated list, UK HMT consolidated list.
- End-use concerns: weapons of mass destruction (WMD), missile technology, chemical / biological weapons, military end-use in a Country Group D-5 destination (EAR §744.21).

Prior to any export, the Licensee and Suderra screen the destination, intermediate consignees, and end-user against the lists above. Screening is performed by `{TEMPLATE: screening platform identity}` and results are archived per the internal export-compliance programme.

**Reference date for this list:** 2026-04-24. Sanctions regimes change; the controlling authority is the prevailing list at the time of a given export, not the list captured here. Counsel confirms the list is current at export time.

**(LEGAL REVIEW REQUIRED)**

---

## 4. End-use and end-user due diligence

Suderra and the Licensee jointly conduct end-user due diligence before a first export. Red flags that trigger enhanced review:

- Prospective end-user on any restricted list at §3.
- End-user in a Country Group D:1, D:3, D:4, or D:5 destination (EAR Supplement 1 to Part 740).
- Stated or inferred end-use in nuclear, chemical, biological, missile, or military applications.
- Mismatch between stated end-use and apparent operational profile (e.g. a "water-quality monitoring" customer in a territory with no documented aquaculture activity).
- End-user refuses to provide an end-use statement or attempts to route shipment through an unrelated intermediate.

Red flags are reviewed by `{TEMPLATE: internal reviewer function}`; unresolved red flags halt the transaction.

Internal export-compliance programme structure is handled separately (see `commercial/support-contract.md`); referenced here for completeness.

**(LEGAL REVIEW REQUIRED)**

---

## 5. Re-export

The Licensee's re-export of the Edge Agent (including transfer to an affiliate or to a contractor) is subject to the same controls as the original export. The Licensee commits in the master agreement not to re-export, transfer, or make available the Edge Agent to any prohibited destination, restricted entity, or prohibited end-use without prior written authorisation from Suderra and the relevant export-control authority.

**(LEGAL REVIEW REQUIRED)**

---

## 6. Crypto-inventory cross-reference

The cryptographic primitives enumerated in §2.1 are authoritatively recorded in `../security/crypto-inventory.md`. The classification reasoning above is re-verified against the inventory on every minor release. Any addition of a new primitive (post-quantum KEM, homomorphic encryption, oblivious transfer, secure-multiparty computation, etc.) requires re-classification before release.

---

## 7. Record-keeping

Suderra retains records of classification reasoning, screening results, and export transactions for the longer of:

- Five years from the date of export (US EAR §762.6 default retention).
- Ten years (EU dual-use regulation national implementing provisions, longest observed).
- The retention period required by the governing law of the master agreement.

Records are available to competent authorities on lawful request.

**(LEGAL REVIEW REQUIRED)**

---

Export-control reference date: 2026-04-24
