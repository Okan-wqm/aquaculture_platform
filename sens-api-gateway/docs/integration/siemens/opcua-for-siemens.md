# OPC UA for Siemens

**Scope:** What a Siemens OT architect gets from this gateway's OPC UA surface today, and what is on the committed roadmap. This chapter is explicitly **honest-today vs. roadmap** — a Siemens production project cannot use today's default posture.

---

## Siemens version compatibility matrix

| Siemens OPC UA consumer | Tested against gateway today | Required gateway posture | Status |
|---|---|---|---|
| TIA Portal OPC UA client (v16-v19) | Reachable on SecurityPolicy None | Basic256Sha256 + SignAndEncrypt required for production | ROADMAP Q2-Q3 2026 (ORPHAN-EDGE-005) |
| WinCC Unified OPC UA client (V18/V19) | Reachable on SecurityPolicy None | Basic256Sha256 + SignAndEncrypt required for production | ROADMAP Q2-Q3 2026 |
| S7-1500 OPC UA client (firmware V2.9+) | Outbound direction (gateway as client) works | Basic256Sha256 accepted on client side | CLIENT-SIDE POLICY MAPPING PRESENT in enum; full negotiation validation TBD |
| WinCC V7.5 OPC UA client | Reachable on SecurityPolicy None | Same as above | ROADMAP Q2-Q3 2026 |
| SIMATIC PCS 7 V9.1 | Not tested | Basic256Sha256 minimum | NOT CERTIFIED |

---

## Today's state — honest

The gateway today ships a **hand-rolled OPC UA Binary client**, not a production-grade stack. Evidence:

- Protocol-level constants and TCP framing are implemented directly on top of `tokio::net::TcpStream` (`src/plc_programming/opcua.rs:42-43`).
- Security policy URIs are encoded as string constants (`src/plc_programming/opcua.rs:69-71`).
- The `OpcUaSecurityPolicy::None` variant is reachable (`src/plc_programming/opcua.rs:392`) — and critically, the `Default` instance of `OpcUaConfig` sets `security_policy: OpcUaSecurityPolicy::None` and `security_mode: OpcUaSecurityMode::None` (`src/plc_programming/opcua.rs:437-438`).

This means an operator who accepts the default YAML configuration starts a gateway with no signing and no encryption on the OPC UA channel. That posture is NOT acceptable for a Siemens production project. Operators MUST set `security_policy: basic256_sha256` and `security_mode: sign_and_encrypt` in the agent YAML explicitly, AND the underlying stack must be migrated to a crypto-validated OPC UA crate before a production deployment.

### Finding ID

**ORPHAN-EDGE-005** — "OPC UA hand-rolled client with SECURITY_POLICY_NONE reachable as default". Severity: HIGH. Owner: protocol team. Target resolution: Q2-Q3 2026 (migrate to `opcua = "0.12"` crate with full Basic256Sha256 + SignAndEncrypt enforcement and certificate store PKI).

---

## Security-policy matrix (today vs. roadmap)

| Security policy URI | Enum variant | Today: negotiable | Roadmap: Q2-Q3 2026 |
|---|---|---|---|
| `http://opcfoundation.org/UA/SecurityPolicy#None` | `OpcUaSecurityPolicy::None` | YES (default) | REMOVED from non-debug builds |
| `http://opcfoundation.org/UA/SecurityPolicy#Basic128Rsa15` | `OpcUaSecurityPolicy::Basic128Rsa15` | YES only in `cfg(debug_assertions)` (deprecated by OPC Foundation 2019) | REMOVED entirely |
| `http://opcfoundation.org/UA/SecurityPolicy#Basic256` | `OpcUaSecurityPolicy::Basic256` | YES — URI declared, full crypto TBD | SUPPORTED |
| `http://opcfoundation.org/UA/SecurityPolicy#Basic256Sha256` | `OpcUaSecurityPolicy::Basic256Sha256` | YES — URI declared; default for enum but not default for `OpcUaConfig` instance | DEFAULT — ENFORCED on production builds |
| `http://opcfoundation.org/UA/SecurityPolicy#Aes128_Sha256_RsaOaep` | `OpcUaSecurityPolicy::Aes128Sha256RsaOaep` | YES — URI declared | SUPPORTED |
| `http://opcfoundation.org/UA/SecurityPolicy#Aes256_Sha256_RsaPss` | `OpcUaSecurityPolicy::Aes256Sha256RsaPss` | YES — URI declared | SUPPORTED |

Evidence: `src/plc_programming/opcua.rs:391-418`.

Key nuance: the **enum-level `Default`** for `OpcUaSecurityPolicy` is `Basic256Sha256` (`opcua.rs:396-397`), but the **struct-level `Default for OpcUaConfig`** overrides this back to `None` (`opcua.rs:437`). Any deployment that relies on `OpcUaConfig::default()` therefore gets the insecure posture. The roadmap aligns both defaults to `Basic256Sha256`.

---

## Security-mode matrix

| OPC UA SecurityMode | Enum variant | Wire code | Today: supported | Required for Siemens production |
|---|---|---|---|---|
| None | `OpcUaSecurityMode::None` | 1 | YES (default) | NO |
| Sign | `OpcUaSecurityMode::Sign` | 2 | YES | Acceptable for non-PII |
| SignAndEncrypt | `OpcUaSecurityMode::SignAndEncrypt` | 3 | YES | YES — MANDATORY for production |

Evidence: `src/plc_programming/opcua.rs:420-430`, mapping `:1441`, `:2916`.

---

## UserIdentityToken modes

| Identity token | Gateway support today | Configuration field | Evidence |
|---|---|---|---|
| Anonymous | YES — sent when no `username` is configured | none | `opcua.rs:2033` (AnonymousIdentityToken type id 321) |
| Username / Password | YES | `username`, `password` in `OpcUaConfig` | `opcua.rs:347-352` |
| X.509 Certificate | Config fields accepted (`client_cert_path`, `client_key_path`) — full certificate-based authentication path not exercised by tests | `opcua.rs:354-358` | — |
| IssuedToken (OAuth2 / JWT) | NOT SUPPORTED — no code path | — | — |

Post-migration (Q2-Q3 2026), Username/Password is only accepted when the channel is in SignAndEncrypt mode; X.509 certificate tokens become the production default for device-to-device OPC UA.

---

## Implemented OPC UA services

| Service | Request / Response Type IDs | Purpose | Evidence |
|---|---|---|---|
| CreateSession | 461 / 464 | Open a session after SecureChannel is established | `opcua.rs:77-80` |
| ActivateSession | 467 / 470 | Bind UserIdentityToken to the session | `opcua.rs:81-84` |
| CloseSession | 473 / 476 | Orderly session shutdown | `opcua.rs:133-136` |
| Browse | 527 / 530 | Address-space traversal (TIA Portal uses this) | `opcua.rs:87-90` |
| BrowseNext | 531 / 534 | Continuation of a long Browse | `opcua.rs:146-149` |
| Read | 631 / 634 | Tag / attribute read | `opcua.rs:91-94` |
| Write | 673 / 676 | Tag write | `opcua.rs:95-98` |
| Call | 712 / 715 | Method invocation (e.g. PLC Start / Stop) | `opcua.rs:99-102` |
| FindServers | 420 / 423 | Discovery | `opcua.rs:108-111` |
| GetEndpoints | 426 / 429 | Endpoint enumeration | `opcua.rs:112-115` |
| RegisterServer / RegisterServer2 | 437/440, 12193/12194 | Discovery registration | `opcua.rs:116-127` |
| Cancel | 479 / 482 | Cancel in-flight request | `opcua.rs:137-140` |
| Subscription / MonitoredItems | — | NOT IMPLEMENTED today; roadmap with `opcua = "0.12"` migration | — |
| HistoryRead (HA profile) | — | NOT IMPLEMENTED today; roadmap Q4 2026 | — |
| TranslateBrowsePathsToNodeIds | — | Declared in constants area; implementation-level exercise not confirmed | `opcua.rs:150` |

---

## Siemens-specific expectations (post-migration)

The Q2-Q3 2026 migration to `opcua = "0.12"` must close these Siemens-specific expectations, otherwise a WinCC / TIA integration will flag them at acceptance:

1. **Structured DataTypes.** Siemens S7-1500 OPC UA servers expose UDT (User-Defined Types) as OPC UA Structured DataTypes. The migrated stack must decode Structured values, not only scalar. Roadmap commitment: Q3 2026.
2. **Method calls with Structured arguments.** `CallRequest` (type id 712) is implemented in the hand-rolled stack (`opcua.rs:99`) but argument encoding covers scalars only today. Structured-argument support lands with the crate migration.
3. **Historical Access (HA) profile.** Not implemented today. Target Q4 2026 if a customer RFP flags it; otherwise remains roadmap.
4. **Namespace URIs.** The gateway today uses `program_namespace` as a configured free-form URI (`opcua.rs:374-378`). Post-migration, a namespace array is published via `Server.NamespaceArray` following the OPC UA spec.
5. **Node ID layout for aquaculture use-cases.** Target conventions (post-migration):
   - `ns=2;s=Gateway/Device/<device_id>/Telemetry/<metric>` for telemetry
   - `ns=2;s=Gateway/Device/<device_id>/Command/<command_name>` for commands
   - `ns=2;s=Gateway/Sensors/<sensor_id>/Value` for sensor leaf nodes

---

## Migration plan (Q2-Q3 2026, ORPHAN-EDGE-005)

1. Replace the hand-rolled client in `src/plc_programming/opcua.rs` with `opcua = "0.12"` crate integration (Rust OPC UA stack, OPC UA Foundation-aligned, IEC 62541-compliant).
2. Enforce `Basic256Sha256 + SignAndEncrypt` as the minimum posture in release builds (compile-time `debug_assertions` gating removes `None`).
3. PKI: wire a certificate store with a Siemens-compatible trust list directory layout (`/etc/suderra/opcua/pki/trusted|rejected|issuers/...`). Owner: security architecture.
4. Expose a local OPC UA server (not just client) with a node hierarchy matching Section "Siemens-specific expectations".
5. Add conformance test evidence per OPC Foundation CTT (Compliance Test Tool). Tracked by `compliance-evidence-writer`.

---

## Cross-reference

- Hand-rolled stack wire reference: `sens-api-gateway/docs/protocols/opcua.md`
- Security architecture + PKI: `sens-api-gateway/docs/security/`
- IEC 62541 compliance evidence (post-migration): `sens-api-gateway/docs/compliance/`
- TIA Portal integration paths: `tia-portal.md`
