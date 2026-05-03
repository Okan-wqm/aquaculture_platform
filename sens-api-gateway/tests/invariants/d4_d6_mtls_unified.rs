//! Phase 1.1.5 — D-4 / D-6 mTLS unified-assembly closure invariant.
//!
//! ## Why this file exists
//!
//! Phase 1 of the Faz 2 closure plan ships the operational wires that
//! make the rustls `SuderraServerCertVerifier` hot-reloadable without an
//! agent restart:
//!
//! - **Phase 1.1.1** (`mtls/state_handle.rs::MtlsVerifierState`) — the
//!   atomic-swap state handle wrapping `Option<Arc<SuderraServerCertVerifier>>`.
//! - **Phase 1.1.4 part A** (`mtls/state_handle.rs::MtlsDelegatingVerifier`,
//!   `mqtt.rs::configure_tls`) — the delegating verifier wrapper that
//!   queries the state handle on every handshake, plus the
//!   `MqttClient::mtls_verifier_state()` accessor that lets
//!   `cmd_update_cert_pinning` (Phase 1.1.2) drive rebuilds.
//! - **Phase 1.1.2** (commands/cert_pinning.rs, planned) — the MQTT
//!   command that ed25519-verifies + replay-guards + two-person-gates an
//!   incoming pin-rotation manifest, then calls `state.rebuild()`.
//! - **Phase 1.1.3** (cloud HTTPS reqwest wire, planned) — the HTTPS
//!   transport reusing the same state handle so cipher allowlist + leaf
//!   pinning span both transports.
//!
//! These four wires are tightly coupled: deleting any one silently
//! reduces D-4 / D-6 closure to a partial state. Pre-Phase-1.1.5 the
//! coupling was prose-only — a future refactor that "simplifies" the
//! DelegatingVerifier wrapper or removes the `mtls_verifier_state` field
//! on `MqttClient` would compile and pass higher-level tests, but
//! `cmd_update_cert_pinning` would silently lose its hot-reload effect.
//!
//! THIS FILE is the Tier-3 MAKE-IT-DETECTABLE seam. It pins the
//! source-level shape of every Phase 1 wire so a regression surfaces
//! deterministically on the same PR that introduced it.
//!
//! Pattern mirrors `tests/invariants/cipher_allowlist_fleet_compat.rs`
//! (Phase 0.4) and `tests/invariants/faz1_architectural_primitives.rs`
//! (Batch #321).

fn read_source(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| {
        panic!(
            "BUG: d4_d6_mtls_unified invariant cannot read {path} — \
             this test runs from sens-api-gateway/ working dir per cargo \
             test convention. err={e}"
        )
    })
}

/// **ULTRA-HIGH-018 / D-4 closure (Phase 1.1.1):** the `MtlsVerifierState`
/// hot-reload handle MUST exist in `mtls/state_handle.rs`. The struct is
/// the single SSoT for the active rustls verifier; deleting it breaks
/// every Phase 1 wire downstream of it (cmd_update_cert_pinning has
/// nothing to rebuild; the DelegatingVerifier has nothing to delegate to).
#[test]
fn d4_mtls_verifier_state_struct_present() {
    let src = read_source("src/mtls/state_handle.rs");
    assert!(
        src.contains("pub struct MtlsVerifierState"),
        "ULTRA-HIGH-018 / D-4 WIRE INVARIANT VIOLATED: \
         src/mtls/state_handle.rs does not define `pub struct MtlsVerifierState`. \
         The state handle is the SSoT for the active rustls verifier — without it, \
         hot-reload is impossible. Restore the struct or document the rename + \
         update this invariant."
    );
}

/// **ULTRA-HIGH-018 / D-4 closure (Phase 1.1.1):** the `rebuild` method
/// is the operator-driven mutation point. cmd_update_cert_pinning calls
/// it from the command-dispatch path; a missing/renamed method silently
/// disables the rotation flow.
#[test]
fn d4_mtls_verifier_state_rebuild_method_present() {
    let src = read_source("src/mtls/state_handle.rs");
    assert!(
        src.contains("pub fn rebuild("),
        "ULTRA-HIGH-018 / D-4 WIRE INVARIANT VIOLATED: \
         src/mtls/state_handle.rs does not expose `pub fn rebuild(...)` on \
         MtlsVerifierState. cmd_update_cert_pinning needs this method to apply \
         a new pin set without restarting the agent."
    );
}

/// **ULTRA-HIGH-020 / D-6 closure (Phase 1.1.4 part A):** the
/// `MtlsDelegatingVerifier` wrapper MUST exist. It is the bridge between
/// the state handle (which mutates) and the rustls ClientConfig (which
/// captures verifiers at boot). Without the wrapper, rebuilds have no
/// effect on live connections.
#[test]
fn d6_mtls_delegating_verifier_struct_present() {
    let src = read_source("src/mtls/state_handle.rs");
    assert!(
        src.contains("pub struct MtlsDelegatingVerifier"),
        "ULTRA-HIGH-020 / D-6 WIRE INVARIANT VIOLATED: \
         src/mtls/state_handle.rs does not define `pub struct MtlsDelegatingVerifier`. \
         The wrapper is the architectural lynchpin that makes hot-reload visible to \
         live TLS connections — its `verify_server_cert` callback re-reads \
         `state.current()` on every handshake."
    );
}

/// **ULTRA-HIGH-020 / D-6 closure (Phase 1.1.4 part A):** the wrapper
/// must impl `rustls::client::danger::ServerCertVerifier`. Anchored on
/// the `impl ServerCertVerifier for MtlsDelegatingVerifier` block.
#[test]
fn d6_mtls_delegating_verifier_implements_server_cert_verifier() {
    let src = read_source("src/mtls/state_handle.rs");
    assert!(
        src.contains("impl ServerCertVerifier for MtlsDelegatingVerifier"),
        "ULTRA-HIGH-020 / D-6 WIRE INVARIANT VIOLATED: \
         MtlsDelegatingVerifier does not implement rustls' ServerCertVerifier. \
         Without this impl the wrapper cannot be installed via \
         ClientConfig::dangerous().with_custom_certificate_verifier(...) — \
         hot-reload is structurally impossible."
    );
}

/// **ULTRA-HIGH-020 / D-6 closure (Phase 1.1.4 part A):**
/// `mqtt.rs::configure_tls` MUST construct + install the
/// `MtlsDelegatingVerifier` rather than the bare
/// `Arc<SuderraServerCertVerifier>`. A revert to the pre-Phase-1 wire
/// (which captured the verifier at boot) silently breaks hot-reload —
/// the symptom is an operator running `cmd_update_cert_pinning` and
/// seeing the rebuild return Ok but the next handshake using the OLD
/// verifier. This test catches that drift on the same PR that introduces it.
#[test]
fn d6_mqtt_configure_tls_installs_delegating_verifier() {
    let src = read_source("src/mqtt.rs");
    assert!(
        src.contains("MtlsDelegatingVerifier::new"),
        "ULTRA-HIGH-020 / D-6 WIRE INVARIANT VIOLATED: \
         src/mqtt.rs does not call MtlsDelegatingVerifier::new. The MQTT TLS path \
         must install the delegating wrapper (not a bare Arc<SuderraServerCertVerifier>) \
         so cmd_update_cert_pinning rebuilds take effect on the next handshake."
    );
    assert!(
        src.contains("with_custom_certificate_verifier(delegating_verifier)"),
        "ULTRA-HIGH-020 / D-6 WIRE INVARIANT VIOLATED: \
         src/mqtt.rs does not pass `delegating_verifier` to \
         with_custom_certificate_verifier. The wrapper must be the verifier \
         installed in the rustls ClientConfig; bypassing it (e.g., calling \
         with_custom_certificate_verifier with the inner SuderraServerCertVerifier) \
         silently disables hot-reload."
    );
}

/// **ULTRA-HIGH-018 + ULTRA-HIGH-020 closure (Phase 1.1.4 part A):**
/// `MqttClient` MUST hold the state handle so `cmd_update_cert_pinning`
/// (Phase 1.1.2) can clone it via the public accessor. A regression that
/// drops the field would force the command to reach into mqtt-internal
/// state — exactly the cross-module coupling the wire was designed to
/// avoid.
#[test]
fn d4_d6_mqtt_client_holds_state_handle() {
    let src = read_source("src/mqtt.rs");
    assert!(
        src.contains("mtls_verifier_state: Option<Arc<crate::mtls::MtlsVerifierState>>")
            || src.contains("mtls_verifier_state: Option<std::sync::Arc<crate::mtls::MtlsVerifierState>>"),
        "ULTRA-HIGH-018 + ULTRA-HIGH-020 WIRE INVARIANT VIOLATED: \
         struct MqttClient does not declare `mtls_verifier_state: Option<Arc<...MtlsVerifierState>>`. \
         The field is the public bridge between MQTT transport state and the \
         command-dispatch path that drives rotations."
    );
    assert!(
        src.contains("pub fn mtls_verifier_state(") && src.contains("Arc<crate::mtls::MtlsVerifierState>"),
        "ULTRA-HIGH-018 + ULTRA-HIGH-020 WIRE INVARIANT VIOLATED: \
         MqttClient does not expose a `pub fn mtls_verifier_state(...) -> \
         Option<&Arc<MtlsVerifierState>>` accessor. cmd_update_cert_pinning \
         needs this accessor to clone the Arc and drive rebuilds without \
         touching mqtt-internal state."
    );
}

/// **Phase 1.1.4 part A regression guard:** the configure_tls signature
/// MUST return both the `Transport` AND the `Arc<MtlsVerifierState>`.
/// Pre-Phase-1.1.4 the function returned `Result<Transport>`; reverting
/// would orphan the state handle and silently disable hot-reload.
#[test]
fn d6_configure_tls_returns_state_handle() {
    let src = read_source("src/mqtt.rs");
    assert!(
        src.contains("Result<(Transport, Arc<crate::mtls::MtlsVerifierState>)>")
            || src.contains("Result<(Transport, std::sync::Arc<crate::mtls::MtlsVerifierState>)>"),
        "ULTRA-HIGH-020 / D-6 WIRE INVARIANT VIOLATED: \
         configure_tls signature does not return Result<(Transport, Arc<MtlsVerifierState>)>. \
         The function must surface the state handle to MqttClient::new so the handle is \
         stored on the client and reachable from cmd_update_cert_pinning."
    );
}

/// **Phase 1.1.4 part A regression guard:** the `build_fallback_webpki`
/// helper MUST exist + be called from configure_tls. The fallback is the
/// HC-1 path (Legacy + no pins) that the DelegatingVerifier delegates to
/// when `state.current()` returns None. A missing fallback would crash
/// every Legacy-mode handshake on a fresh deploy.
#[test]
fn d6_fallback_webpki_constructed_in_configure_tls() {
    let state_src = read_source("src/mtls/state_handle.rs");
    let mqtt_src = read_source("src/mqtt.rs");
    assert!(
        state_src.contains("pub fn build_fallback_webpki"),
        "ULTRA-HIGH-020 / D-6 WIRE INVARIANT VIOLATED: \
         src/mtls/state_handle.rs does not export `build_fallback_webpki`. The HC-1 \
         fallthrough (Legacy + no pins) requires this fallback verifier."
    );
    assert!(
        mqtt_src.contains("crate::mtls::build_fallback_webpki(")
            || mqtt_src.contains("build_fallback_webpki("),
        "ULTRA-HIGH-020 / D-6 WIRE INVARIANT VIOLATED: \
         src/mqtt.rs does not call build_fallback_webpki. The DelegatingVerifier \
         delegates to this fallback on the HC-1 path; without it Legacy-mode \
         handshakes panic in the wrapper."
    );
}

/// **ORPHAN-HIGH-035 cipher dimension closure (Phase 1.1.3a):** every
/// reqwest HTTPS callsite MUST use `build_suderra_https_client_config`
/// via `use_preconfigured_tls(...)`. A regression that drops this wire
/// reverts the cipher policy on the cloud-bound HTTPS path back to the
/// unrestricted ring provider — the bootstrap-token endpoint becomes
/// vulnerable to TLS 1.2 cipher-suite-downgrade again.
#[test]
fn https_clients_use_suderra_config() {
    for path in [
        "src/provisioning.rs",
        "src/commands/firmware.rs",
        "src/scripting/engine.rs",
    ] {
        let src = read_source(path);
        assert!(
            src.contains("build_suderra_https_client_config"),
            "ORPHAN-HIGH-035 cipher dimension VIOLATED: {path} does not call \
             build_suderra_https_client_config. The HTTPS reqwest path must \
             use the Suderra-narrowed ClientConfig so TLS 1.3 + 3-suite cipher \
             allowlist apply uniformly across MQTT and HTTPS transports."
        );
        assert!(
            src.contains("use_preconfigured_tls"),
            "ORPHAN-HIGH-035 cipher dimension VIOLATED: {path} does not pass \
             the Suderra ClientConfig via use_preconfigured_tls. Without this \
             wire, reqwest defaults to its native cert-loader + the unrestricted \
             rustls global default — Suderra cipher policy is bypassed."
        );
    }
}

/// **Phase 1.1.2 D-4 closure (operator surface):** the
/// `cmd_update_cert_pinning` handler MUST exist + be wired into both
/// the dispatch table AND the cmd→permission mapping. A regression that
/// drops any of these wires reduces the operator-facing surface but
/// leaves the architectural foundation (state handle + delegating
/// wrapper + downgrade gate) — symptom: operators cannot drive
/// rotations via MQTT, but the in-process `state.rebuild()` path still
/// works. This invariant catches that drift on the same PR.
#[test]
fn d4_cmd_update_cert_pinning_handler_present() {
    let src = read_source("src/commands/cert_pinning.rs");
    assert!(
        src.contains("pub(super) async fn cmd_update_cert_pinning"),
        "ULTRA-HIGH-018 / D-4 OPERATOR SURFACE WIRE INVARIANT VIOLATED: \
         src/commands/cert_pinning.rs does not define `cmd_update_cert_pinning`. \
         The handler is the operator-facing MQTT entrypoint that drives \
         MtlsVerifierState::rebuild — without it, hot-reload is reachable \
         only from in-process callers (Phase 1.1.4), not from operators."
    );
    assert!(
        src.contains("verifier_state.rebuild(new_mode, &pins_hex)"),
        "ULTRA-HIGH-018 / D-4 OPERATOR SURFACE WIRE INVARIANT VIOLATED: \
         cmd_update_cert_pinning does not call MtlsVerifierState::rebuild. \
         The handler must drive rebuild() so the Tier-1 downgrade gate \
         enforces the policy floor."
    );
}

/// **Phase 1.1.2 D-4 closure (dispatch wire):** the
/// `update_cert_pinning` command name MUST be in the
/// `dispatch_lifecycle` match arm. A regression that comments out or
/// removes the arm orphans the handler — code stays compiled but
/// operators get a "command not found" error.
#[test]
fn d4_update_cert_pinning_dispatch_wire_present() {
    let src = read_source("src/commands/dispatch_lifecycle.rs");
    assert!(
        src.contains("\"update_cert_pinning\"") && src.contains("cmd_update_cert_pinning"),
        "ULTRA-HIGH-018 / D-4 DISPATCH WIRE INVARIANT VIOLATED: \
         src/commands/dispatch_lifecycle.rs match table does not route \
         \"update_cert_pinning\" → self.cmd_update_cert_pinning. The \
         handler is unreachable from MQTT inbound commands."
    );
}

/// **Phase 1.1.2 D-4 closure (RBAC permission gate):** the
/// `update_cert_pinning` command MUST map to
/// `Permission::ManageCertPinning` in the cmd→permission table.
/// A regression that maps it to ManagePolicy (or omits it) collapses
/// the HSM-slot separation that ADR-021 §1 reserves between RBAC and
/// pinning rotations — an operator with RBAC authority would
/// auto-inherit pinning authority.
#[test]
fn d4_update_cert_pinning_requires_manage_cert_pinning_permission() {
    let src = read_source("src/commands/required_permission.rs");
    assert!(
        src.contains("\"update_cert_pinning\"")
            && src.contains("Permission::ManageCertPinning"),
        "ULTRA-HIGH-018 / D-4 RBAC GATE INVARIANT VIOLATED: \
         src/commands/required_permission.rs does not map \"update_cert_pinning\" \
         to Permission::ManageCertPinning. Mapping it to ManagePolicy collapses \
         the HSM-slot separation; omitting it lets the command bypass the RBAC \
         gate entirely."
    );
}

/// **Phase 1.1.2 (Permission enum additive contract):** the new
/// `ManageCertPinning` variant MUST exist on the Permission enum. Per
/// the ADR-018 §6 additive-only invariant, this variant cannot be
/// removed without bumping `min_edge_version` — the test pins its
/// presence so a future "cleanup" PR cannot silently delete it.
#[test]
fn permission_manage_cert_pinning_variant_present() {
    let src = read_source("src/authz/permission.rs");
    assert!(
        src.contains("ManageCertPinning"),
        "ULTRA-HIGH-018 / Permission enum INVARIANT VIOLATED: \
         src/authz/permission.rs does not declare the ManageCertPinning variant. \
         ADR-018 §6 additive-only contract: variants cannot be removed without \
         a min_edge_version bump."
    );
}

/// **ORPHAN-MEDIUM-036/037 closure (audit-sink HMAC chain emit):** the
/// `action_for_command` table at `commands/audit_emit.rs::42` MUST have
/// an explicit case for `"update_cert_pinning"` so the existing
/// command-dispatch audit pipeline emits a specific
/// `MqttCertRotated` / `MqttCertRotationRolledBack` action rather than
/// the catch-all `CommandExecuted`. Without this mapping, audit-stream
/// queries cannot distinguish a cert-pinning rotation event from any
/// other command, which defeats forensic post-mortem.
#[test]
fn audit_emit_table_classifies_update_cert_pinning() {
    let src = read_source("src/commands/audit_emit.rs");
    assert!(
        src.contains("\"update_cert_pinning\""),
        "ORPHAN-MEDIUM-036/037 VIOLATED: src/commands/audit_emit.rs \
         action_for_command table does not have an explicit case for \
         \"update_cert_pinning\". Without it, audit emits fall through to \
         CommandExecuted/CommandRejected — forensic queries cannot \
         distinguish pin rotations from generic commands."
    );
    assert!(
        src.contains("MqttCertRotated") && src.contains("MqttCertRotationRolledBack"),
        "ORPHAN-MEDIUM-036/037 VIOLATED: src/commands/audit_emit.rs \
         does not route to MqttCertRotated (success) and MqttCertRotationRolledBack \
         (failure) actions. Both wire_tags are pre-staged in audit/entry.rs \
         for this exact surface."
    );
}

/// **ORPHAN-HIGH-035 cipher dimension closure (Phase 1.1.3a):** the
/// helper itself MUST exist + use TLS 1.3 + the Suderra crypto provider.
/// Pins the source-level shape so an "optimization" that swaps in
/// `rustls::ClientConfig::with_safe_defaults()` (which uses the
/// unrestricted ring provider) is caught at test time.
#[test]
fn https_helper_uses_tls13_and_suderra_provider() {
    let src = read_source("src/mtls/https_client_config.rs");
    assert!(
        src.contains("build_suderra_crypto_provider"),
        "ORPHAN-HIGH-035 cipher dimension VIOLATED: \
         src/mtls/https_client_config.rs does not invoke build_suderra_crypto_provider. \
         The HTTPS factory must produce a ClientConfig narrowed to the 3-suite TLS 1.3 \
         allowlist; using ring's default_provider re-admits TLS 1.2 ciphers."
    );
    assert!(
        src.contains("with_protocol_versions(&[&rustls::version::TLS13])")
            || src.contains("&[&rustls::version::TLS13]"),
        "ORPHAN-HIGH-035 cipher dimension VIOLATED: \
         src/mtls/https_client_config.rs does not pin protocol version to TLS 1.3. \
         Even with the cipher allowlist narrowed, an explicit version pin is \
         defense-in-depth against future rustls feature flags re-enabling TLS 1.2."
    );
}
