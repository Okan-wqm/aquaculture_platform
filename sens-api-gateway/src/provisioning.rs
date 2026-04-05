//! Device provisioning and activation
//!
//! Handles the zero-touch provisioning flow:
//! 1. Collect device fingerprint
//! 2. Send activation request to cloud API
//! 3. Receive MQTT credentials
//! 4. Update local config

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

use crate::AppState;
use crate::error::{ActivationErrorCode, AgentError};

/// Mask a sensitive token for logging purposes (IEC 62443 SL2 FR3)
///
/// Shows first 4 and last 4 characters with ellipsis in between.
/// For short tokens (< 20 chars), shows only asterisks to prevent brute-force
/// recovery from partial exposure — a token shorter than 20 chars has at most
/// ~10 unknown chars which may be feasible to exhaust.
///
/// # Security
/// Prevents token leakage in log files while allowing debugging.
///
/// # LOW-41: Raised threshold from 12 → 20 chars (reduces partial-token exposure risk)
///
/// # v1.2.6: UTF-8 Safe
/// Uses char indices to prevent panic on multi-byte characters.
fn mask_token(token: &str) -> String {
    let char_count = token.chars().count();
    if char_count >= 20 {
        // Get first 4 chars safely
        let first_4: String = token.chars().take(4).collect();
        // Get last 4 chars safely
        let last_4: String = token.chars().skip(char_count - 4).collect();
        format!("{}...{}", first_4, last_4)
    } else if !token.is_empty() {
        "*".repeat(char_count.min(8))
    } else {
        "(empty)".to_string()
    }
}

/// Provisioning client for device activation
pub struct ProvisioningClient {
    state: Arc<RwLock<AppState>>,
    http_client: reqwest::Client,
}

/// Device fingerprint collected from hardware
///
/// # GDPR / Privacy (LOW-45)
/// MAC addresses are SHA-256 hashed before inclusion so that no raw hardware
/// identifiers leave the device. The hash is stable across reboots (deterministic
/// input) so the cloud can still correlate re-provisioning events, but the value
/// cannot be reversed to recover the original MAC address.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFingerprint {
    /// CPU serial number (if available)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_serial: Option<String>,

    /// SHA-256 hashed MAC addresses (hex-encoded, one per network interface).
    /// Raw MAC addresses are NOT transmitted — only their pseudonymised hashes.
    pub mac_addresses: Vec<String>,

    /// Machine ID (from /etc/machine-id)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<String>,

    /// Hostname
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
}

/// Activation request sent to cloud API
///
/// # Security Note (v1.2.0)
/// Custom Debug implementation masks the token to prevent log leakage.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivationRequest {
    pub device_id: String,
    pub token: String,
    pub fingerprint: DeviceFingerprint,
    pub agent_version: String,
}

impl std::fmt::Debug for ActivationRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ActivationRequest")
            .field("device_id", &self.device_id)
            .field("token", &mask_token(&self.token))
            .field("fingerprint", &self.fingerprint)
            .field("agent_version", &self.agent_version)
            .finish()
    }
}

/// Activation response from cloud API (snake_case per v1.1 spec)
///
/// # Security (C-EDGE-01)
/// `#[derive(Debug)]` is intentionally NOT used — the derived impl would
/// print `mqtt_password` in plain text to logs. Custom `Debug` impl below
/// redacts the password field following the same pattern as `ActivationRequest`.
#[derive(Deserialize)]
#[allow(dead_code)]
pub struct ActivationResponse {
    pub success: bool,
    pub mqtt_broker: String,
    pub mqtt_port: u16,
    pub mqtt_username: String,
    pub mqtt_password: String,
    pub tenant_id: String,
    pub device_code: String,
    #[serde(default)]
    pub config: Option<serde_json::Value>,
    #[serde(default)]
    pub mqtt_tls_enabled: Option<bool>,
}

impl std::fmt::Debug for ActivationResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ActivationResponse")
            .field("success", &self.success)
            .field("mqtt_broker", &self.mqtt_broker)
            .field("mqtt_port", &self.mqtt_port)
            .field("mqtt_username", &self.mqtt_username)
            .field("mqtt_password", &"[REDACTED]")
            .field("tenant_id", &self.tenant_id)
            .field("device_code", &self.device_code)
            .field("mqtt_tls_enabled", &self.mqtt_tls_enabled)
            .finish()
    }
}

/// Error response from cloud API
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct ActivationErrorResponse {
    pub success: bool,
    pub error: String,
    #[serde(rename = "errorCode")]
    pub error_code: String,
}

/// Self-register request sent to cloud API (tenant-level provisioning)
#[derive(Serialize)]
pub struct SelfRegisterRequest {
    pub tenant_token: String,
    pub fingerprint: DeviceFingerprint,
    pub agent_version: String,
}

impl std::fmt::Debug for SelfRegisterRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SelfRegisterRequest")
            .field("tenant_token", &mask_token(&self.tenant_token))
            .field("fingerprint", &self.fingerprint)
            .field("agent_version", &self.agent_version)
            .finish()
    }
}

/// Self-register response from cloud API
///
/// # Security (C-EDGE-01 twin)
/// `#[derive(Debug)]` intentionally absent — derived impl would print
/// `mqtt_password` in plaintext. Manual impl below redacts the field,
/// consistent with `ActivationResponse` and `ActivationRequest`.
#[derive(Deserialize)]
pub struct SelfRegisterResponse {
    pub success: bool,
    pub device_id: String,
    pub device_code: String,
    pub mqtt_broker: String,
    pub mqtt_port: u16,
    pub mqtt_username: String,
    pub mqtt_password: String,
    pub tenant_id: String,
    #[serde(default)]
    pub config: Option<serde_json::Value>,
    #[serde(default)]
    pub mqtt_tls_enabled: Option<bool>,
}

impl std::fmt::Debug for SelfRegisterResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SelfRegisterResponse")
            .field("success", &self.success)
            .field("device_id", &self.device_id)
            .field("device_code", &self.device_code)
            .field("mqtt_broker", &self.mqtt_broker)
            .field("mqtt_port", &self.mqtt_port)
            .field("mqtt_username", &self.mqtt_username)
            .field("mqtt_password", &"[REDACTED]")
            .field("tenant_id", &self.tenant_id)
            .field("mqtt_tls_enabled", &self.mqtt_tls_enabled)
            .finish()
    }
}

impl ProvisioningClient {
    /// Create a new provisioning client
    pub fn new(state: Arc<RwLock<AppState>>) -> Result<Self> {
        // Use system CA store for TLS verification. The cloud API uses Let's Encrypt
        // certificates which rotate every 90 days, making CA pinning impractical.
        //
        // Security is maintained through:
        // - HTTPS with standard certificate validation (system CA store)
        // - Provisioning tokens are single-use and time-limited
        // - MQTT credentials are rotated on each activation
        let http_client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .tls_built_in_root_certs(true)
            .redirect(reqwest::redirect::Policy::none()) // Block cross-origin redirects leaking token
            .build()
            .context("Failed to create HTTP client")?;

        Ok(Self { state, http_client })
    }

    /// Activate device with cloud platform
    pub async fn activate(&self) -> Result<ActivationResponse> {
        use secrecy::ExposeSecret;
        let (api_url, device_id, token) = {
            let state = self.state.read().await;
            let secret_token = state
                .config
                .provisioning_token
                .clone()
                .ok_or_else(|| AgentError::NotActivated)?;
            // Expose only at the point of use — not stored in a plain String
            let token = secret_token.expose_secret().clone();

            (
                state.config.api_url.clone(),
                state.config.device_id.clone(),
                token,
            )
        };

        // Collect device fingerprint
        info!("Collecting device fingerprint...");
        let fingerprint = self.collect_fingerprint().await;
        // Log fingerprint collection without exposing full hardware IDs (v1.2.0 security)
        debug!(
            "Fingerprint collected: {} MAC address(es), hostname={:?}",
            fingerprint.mac_addresses.len(),
            fingerprint.hostname.as_deref().unwrap_or("(none)")
        );

        // Build activation request
        let request = ActivationRequest {
            device_id: device_id.clone(),
            token,
            fingerprint,
            agent_version: env!("CARGO_PKG_VERSION").to_string(),
        };

        // Send activation request
        let url = format!("{}/api/devices/activate", api_url);
        info!("Sending activation request to {}", url);

        let response = self
            .http_client
            .post(&url)
            .json(&request)
            .send()
            .await
            .context("Failed to send activation request")?;

        let status = response.status();
        let body = response
            .text()
            .await
            .context("Failed to read response body")?;

        // Log response status only - body may contain MQTT credentials (v1.2.0 security)
        debug!(
            "Response status: {}, body_len: {} bytes",
            status,
            body.len()
        );

        // Handle response
        if status.is_success() {
            let activation: ActivationResponse =
                serde_json::from_str(&body).context("Failed to parse activation response")?;

            if activation.success {
                info!("Activation successful for device {}", device_id);
                return Ok(activation);
            }
        }

        // Try to parse error response
        if let Ok(error_response) = serde_json::from_str::<ActivationErrorResponse>(&body) {
            warn!(
                "Activation failed: {} ({})",
                error_response.error, error_response.error_code
            );

            if let Some(code) = ActivationErrorCode::from_str(&error_response.error_code) {
                return Err(AgentError::from(code).into());
            }

            return Err(AgentError::Provisioning(error_response.error).into());
        }

        // Unknown error - truncate body in logs to prevent credential leakage (v1.2.0 security)
        // v1.2.6: Use char boundary safe truncation to prevent UTF-8 panic
        let truncated_body = if body.len() > 100 {
            // Find valid UTF-8 boundary at or before position 100
            let safe_end = body
                .char_indices()
                .take_while(|(i, _)| *i < 100)
                .last()
                .map(|(i, c)| i + c.len_utf8())
                .unwrap_or(0);
            format!("{}...(truncated)", &body[..safe_end])
        } else {
            body.clone()
        };
        error!(
            "Activation failed with status {}: {}",
            status, truncated_body
        );
        Err(AgentError::Unknown(format!("HTTP {}", status)).into())
    }

    /// Self-register device with cloud platform using tenant token (v2.0)
    ///
    /// Used for tenant-first provisioning where the device doesn't have
    /// a pre-assigned device_id. The cloud platform creates the device
    /// record and returns credentials.
    pub async fn self_register(&self) -> Result<SelfRegisterResponse> {
        use secrecy::ExposeSecret;
        let (api_url, tenant_token) = {
            let state = self.state.read().await;
            let secret = state
                .config
                .tenant_token
                .clone()
                .ok_or_else(|| AgentError::Provisioning("No tenant_token in config".to_string()))?;
            let token = secret.expose_secret().clone();

            (state.config.api_url.clone(), token)
        };

        // Collect device fingerprint
        info!("Collecting device fingerprint for self-registration...");
        let fingerprint = self.collect_fingerprint().await;
        debug!(
            "Fingerprint collected: {} MAC address(es), hostname={:?}",
            fingerprint.mac_addresses.len(),
            fingerprint.hostname.as_deref().unwrap_or("(none)")
        );

        // Build self-register request
        let request = SelfRegisterRequest {
            tenant_token,
            fingerprint,
            agent_version: env!("CARGO_PKG_VERSION").to_string(),
        };

        // Send self-register request
        let url = format!("{}/api/devices/self-register", api_url);
        info!("Sending self-register request to {}", url);

        let response = self
            .http_client
            .post(&url)
            .json(&request)
            .send()
            .await
            .context("Failed to send self-register request")?;

        let status = response.status();
        let body = response
            .text()
            .await
            .context("Failed to read response body")?;

        debug!(
            "Response status: {}, body_len: {} bytes",
            status,
            body.len()
        );

        if status.is_success() {
            let registration: SelfRegisterResponse =
                serde_json::from_str(&body).context("Failed to parse self-register response")?;

            if registration.success {
                info!(
                    "Self-registration successful! device_id={}, device_code={}",
                    registration.device_id, registration.device_code
                );
                return Ok(registration);
            }
        }

        // Try to parse error response
        if let Ok(error_response) = serde_json::from_str::<ActivationErrorResponse>(&body) {
            warn!(
                "Self-registration failed: {} ({})",
                error_response.error, error_response.error_code
            );
            return Err(AgentError::Provisioning(error_response.error).into());
        }

        let truncated_body = if body.len() > 100 {
            let safe_end = body
                .char_indices()
                .take_while(|(i, _)| *i < 100)
                .last()
                .map(|(i, c)| i + c.len_utf8())
                .unwrap_or(0);
            format!("{}...(truncated)", &body[..safe_end])
        } else {
            body.clone()
        };
        error!(
            "Self-registration failed with status {}: {}",
            status, truncated_body
        );
        Err(AgentError::Unknown(format!("HTTP {}", status)).into())
    }

    /// Collect device fingerprint
    async fn collect_fingerprint(&self) -> DeviceFingerprint {
        DeviceFingerprint {
            cpu_serial: Self::get_cpu_serial(),
            mac_addresses: Self::get_mac_addresses(),
            machine_id: Self::get_machine_id(),
            hostname: Self::get_hostname(),
        }
    }

    /// Get CPU serial number (Raspberry Pi specific)
    fn get_cpu_serial() -> Option<String> {
        #[cfg(target_os = "linux")]
        {
            // Try to read from /proc/cpuinfo (Raspberry Pi)
            if let Ok(content) = std::fs::read_to_string("/proc/cpuinfo") {
                for line in content.lines() {
                    if line.starts_with("Serial") {
                        if let Some(serial) = line.split(':').nth(1) {
                            return Some(serial.trim().to_string());
                        }
                    }
                }
            }
        }
        None
    }

    /// Hash a MAC address with SHA-256 for GDPR-compliant pseudonymisation (LOW-45).
    ///
    /// The raw MAC is normalised to uppercase before hashing so that
    /// "AA:BB:CC:DD:EE:FF" and "aa:bb:cc:dd:ee:ff" produce the same hash.
    fn hash_mac_address(mac: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(mac.to_uppercase().as_bytes());
        format!("{:x}", hasher.finalize())
    }

    /// Get SHA-256 hashed MAC addresses of all network interfaces.
    ///
    /// Raw MAC addresses are NOT returned — only their pseudonymised hashes.
    fn get_mac_addresses() -> Vec<String> {
        let mut hashes: Vec<String> = Vec::new();

        if let Ok(mac) = mac_address::get_mac_address() {
            if let Some(addr) = mac {
                let hash = Self::hash_mac_address(&addr.to_string());
                hashes.push(hash);
            }
        }

        // Also try named interfaces
        for iface in &["eth0", "wlan0"] {
            if let Ok(Some(addr)) = mac_address::mac_address_by_name(iface) {
                let hash = Self::hash_mac_address(&addr.to_string());
                if !hashes.contains(&hash) {
                    hashes.push(hash);
                }
            }
        }

        hashes
    }

    /// Get machine ID from /etc/machine-id
    fn get_machine_id() -> Option<String> {
        // Try machine-uid crate first
        if let Ok(uid) = machine_uid::get() {
            return Some(uid);
        }

        // Fallback to reading /etc/machine-id directly
        #[cfg(target_os = "linux")]
        {
            if let Ok(id) = std::fs::read_to_string("/etc/machine-id") {
                return Some(id.trim().to_string());
            }
        }

        None
    }

    /// Get hostname
    fn get_hostname() -> Option<String> {
        hostname::get().ok().and_then(|h| h.into_string().ok())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fingerprint_serialization() {
        let fingerprint = DeviceFingerprint {
            cpu_serial: Some("0000000012345678".to_string()),
            mac_addresses: vec!["AA:BB:CC:DD:EE:FF".to_string()],
            machine_id: Some("abc123".to_string()),
            hostname: Some("edge-device".to_string()),
        };

        let json = serde_json::to_string(&fingerprint).unwrap();
        assert!(json.contains("cpuSerial"));
        assert!(json.contains("macAddresses"));
    }

    #[test]
    fn test_activation_request_serialization() {
        let request = ActivationRequest {
            device_id: "device-123".to_string(),
            token: "secret-token".to_string(),
            fingerprint: DeviceFingerprint {
                cpu_serial: None,
                mac_addresses: vec![],
                machine_id: None,
                hostname: None,
            },
            agent_version: "1.0.0".to_string(),
        };

        let json = serde_json::to_string(&request).unwrap();
        assert!(json.contains("deviceId")); // camelCase for request
        assert!(json.contains("agentVersion"));
    }

    #[test]
    fn test_mask_token() {
        // Long token (>= 20 chars) shows first 4 and last 4
        assert_eq!(mask_token("1234567890abcdef01234"), "1234...1234");

        // Tokens under 20 chars show asterisks (LOW-41: raised threshold 12 → 20)
        assert_eq!(mask_token("short"), "*****");
        assert_eq!(mask_token("1234567890abcdef"), "********"); // 16 chars → 8 stars (capped at 8)

        // Empty token
        assert_eq!(mask_token(""), "(empty)");

        // Exactly 20 chars
        assert_eq!(mask_token("12345678901234567890"), "1234...7890");
    }

    #[test]
    fn test_mac_address_hashing() {
        // Hashing is deterministic
        let h1 = ProvisioningClient::hash_mac_address("AA:BB:CC:DD:EE:FF");
        let h2 = ProvisioningClient::hash_mac_address("AA:BB:CC:DD:EE:FF");
        assert_eq!(h1, h2);

        // Case-normalised: lower and upper produce the same hash
        let h3 = ProvisioningClient::hash_mac_address("aa:bb:cc:dd:ee:ff");
        assert_eq!(h1, h3);

        // Different MACs produce different hashes
        let h4 = ProvisioningClient::hash_mac_address("11:22:33:44:55:66");
        assert_ne!(h1, h4);

        // Output is hex-encoded SHA-256 (64 lowercase hex chars)
        assert_eq!(h1.len(), 64);
        assert!(h1.chars().all(|c| c.is_ascii_hexdigit()));

        // Raw MAC is not recoverable from the hash
        assert!(!h1.contains("AA"));
        assert!(!h1.contains("BB"));
    }

    #[test]
    fn test_activation_request_debug_masks_token() {
        let request = ActivationRequest {
            device_id: "device-123".to_string(),
            token: "super-secret-token-12345".to_string(),
            fingerprint: DeviceFingerprint {
                cpu_serial: None,
                mac_addresses: vec![],
                machine_id: None,
                hostname: None,
            },
            agent_version: "1.0.0".to_string(),
        };

        let debug_output = format!("{:?}", request);

        // Debug should NOT contain the actual token
        assert!(!debug_output.contains("super-secret-token-12345"));

        // But should contain the masked version
        assert!(debug_output.contains("supe...2345"));
    }
}
