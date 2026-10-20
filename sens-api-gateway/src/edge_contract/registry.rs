//! The closed vocabularies of the edge contract the agent verifier needs,
//! compiled in.
//!
//! The agent cannot read `contracts/suderra-edge/v1` at run time (it is not
//! on the device), so the parts of statements.json, boards.json and
//! artifact-naming.json the agent verifier uses are mirrored here.
//! `tests/contracts_golden.rs` compares every table with the contract and
//! fails the build on any drift (tier 3, "make it detectable").

use serde::{Deserialize, Serialize};

macro_rules! string_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub enum $name { $($variant),+ }

        impl $name {
            /// Every value, in declaration order.
            pub const ALL: &'static [$name] = &[$($name::$variant),+];

            /// Contract spelling.
            pub fn as_str(self) -> &'static str {
                match self { $($name::$variant => $text),+ }
            }

            /// Parses the contract spelling.
            pub fn parse(text: &str) -> Option<Self> {
                Self::ALL.iter().copied().find(|v| v.as_str() == text)
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str(self.as_str())
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let text = String::deserialize(d)?;
                $name::parse(&text).ok_or_else(|| {
                    serde::de::Error::custom(format!(
                        concat!("unknown ", stringify!($name), " {:?}"),
                        text
                    ))
                })
            }
        }
    };
}

string_enum!(
    /// Rejection codes of signed statements (statements.json
    /// `rejection_reasons`).
    Reason {
        EnvelopeInvalid => "envelope-invalid",
        PayloadTypeMismatch => "payload-type-mismatch",
        KeyUnknown => "key-unknown",
        KeyPurposeMismatch => "key-purpose-mismatch",
        KeyEpochBelowRatchet => "key-epoch-below-ratchet",
        SignatureInvalid => "signature-invalid",
        PayloadJsonInvalid => "payload-json-invalid",
        SchemaInvalid => "schema-invalid",
        KeyEpochMismatch => "key-epoch-mismatch",
        NotYetValid => "not-yet-valid",
        Expired => "expired",
        DeviceBindingMismatch => "device-binding-mismatch",
        DeviceIdMismatch => "device-id-mismatch",
        TenantMismatch => "tenant-mismatch",
        TenantScopeMismatch => "tenant-scope-mismatch",
        NonceMismatch => "nonce-mismatch",
        BoardMismatch => "board-mismatch",
        RollbackBelowFloor => "rollback-below-floor",
        SequenceReplay => "sequence-replay",
        ReleaseDigestMismatch => "release-digest-mismatch",
        ReleaseMismatch => "release-mismatch",
        ReleaseProfileMismatch => "release-profile-mismatch",
        OsVersionTooOld => "os-version-too-old",
        AgentAbiUnsupported => "agent-abi-unsupported",
        KernelConfigMissing => "kernel-config-missing",
        SiteConfigDigestMismatch => "site-config-digest-mismatch",
        TrustAnchorsDigestMismatch => "trust-anchors-digest-mismatch",
        ManifestDigestMismatch => "manifest-digest-mismatch",
        AnchorNotOsPinned => "anchor-not-os-pinned",
        AnchorInvalid => "anchor-invalid",
        SiteFileDigestMismatch => "site-file-digest-mismatch",
        RbacManifestDigestMismatch => "rbac-manifest-digest-mismatch",
        ActorKeyNotAnchored => "actor-key-not-anchored",
        InstalledDigestMismatch => "installed-digest-mismatch",
    }
);

/// statements.json `verification_order`: run in this order, first failure
/// wins.
pub const VERIFICATION_ORDER: [Reason; 8] = [
    Reason::EnvelopeInvalid,
    Reason::PayloadTypeMismatch,
    Reason::KeyUnknown,
    Reason::KeyPurposeMismatch,
    Reason::KeyEpochBelowRatchet,
    Reason::SignatureInvalid,
    Reason::PayloadJsonInvalid,
    Reason::SchemaInvalid,
];

string_enum!(
    /// Signing purposes (statements.json `purposes`, DEC-3.3).
    Purpose {
        EdgeRelease => "edge-release",
        EdgeProvisioning => "edge-provisioning",
        FleetRoot => "fleet-root",
        DeviceLifecycle => "device-lifecycle",
        ConfigIntegrity => "config-integrity",
        RbacManifest => "rbac-manifest",
        Command => "command",
        MqttCa => "mqtt-ca",
    }
);

impl Purpose {
    /// Anchored by a key pinned in the OS image.
    pub fn anchored_in_os_image(self) -> bool {
        matches!(
            self,
            Purpose::EdgeRelease
                | Purpose::EdgeProvisioning
                | Purpose::FleetRoot
                | Purpose::DeviceLifecycle
        )
    }

    /// Anchored in the trust-anchors bundle.
    pub fn anchored_in_bundle(self) -> bool {
        !matches!(self, Purpose::FleetRoot | Purpose::DeviceLifecycle)
    }

    /// Anchored only in the bundle: resolved against a verified bundle.
    pub fn bundle_only(self) -> bool {
        self.anchored_in_bundle() && !self.anchored_in_os_image()
    }

    /// Algorithm (statements.json `purposes[].algorithm`).
    pub fn algorithm(self) -> &'static str {
        if self == Purpose::MqttCa {
            "x509"
        } else {
            "ed25519"
        }
    }
}

string_enum!(
    /// Signed statement types (statements.json `statements`).
    StatementType {
        EdgeRelease => "suderra.edge-release.v1",
        EdgeProvisioning => "suderra.edge-provisioning.v1",
        EdgeActivationReceipt => "suderra.edge-activation-receipt.v1",
        TrustAnchors => "suderra.trust-anchors.v1",
        DeviceLifecycle => "suderra.device-lifecycle.v1",
        SiteConfig => "suderra.site-config.v1",
        RbacManifest => "suderra.rbac-manifest.v1",
    }
);

/// How an equal sequence value is treated (statements.json `sequences`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EqualSeq {
    /// Equal is replay.
    Reject,
    /// Equal is accepted only for the identical accepted statement.
    IdenticalOnly,
}

/// Sequence rule of a statement type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SequenceRule {
    /// Payload member carrying the sequence.
    pub field: &'static str,
    /// Equal-value policy.
    pub equal: EqualSeq,
}

/// One row of statements.json `statements`.
#[derive(Debug, Clone, Copy)]
pub struct StatementSpec {
    /// Key purpose that must sign the statement.
    pub signing_purpose: Purpose,
    /// device_binding and device_id are compared.
    pub device_bound: bool,
    /// tenant_id (or tenant_scope) is compared.
    pub tenant_bound: bool,
    /// Sequence rule, if any.
    pub sequence: Option<SequenceRule>,
    /// Statements delivered with and verified under this one.
    pub nested: &'static [StatementType],
    /// Statement checks after schema validation.
    pub checks: &'static [Reason],
    /// `verified_by.agent.omits` when the agent verifies this type; `None`
    /// when the agent is not a verifier of it.
    pub agent_omits: Option<&'static [Reason]>,
}

impl StatementType {
    /// Short kind used in payload types.
    pub fn kind(self) -> &'static str {
        let name = self.as_str();
        name.strip_prefix("suderra.")
            .and_then(|n| n.strip_suffix(".v1"))
            .unwrap_or(name)
    }

    /// DSSE payloadType this call site pins.
    pub fn payload_type(self) -> String {
        format!("application/vnd.suderra.{}.v1+json", self.kind())
    }

    /// The statements.json row of this type.
    pub fn spec(self) -> StatementSpec {
        use Reason as R;
        use StatementType as T;
        match self {
            T::EdgeRelease => StatementSpec {
                signing_purpose: Purpose::EdgeRelease,
                device_bound: false,
                tenant_bound: false,
                sequence: None,
                nested: &[],
                checks: &[
                    R::ReleaseProfileMismatch,
                    R::BoardMismatch,
                    R::OsVersionTooOld,
                    R::AgentAbiUnsupported,
                    R::KernelConfigMissing,
                ],
                agent_omits: Some(&[R::KeyEpochBelowRatchet]),
            },
            T::EdgeProvisioning => StatementSpec {
                signing_purpose: Purpose::EdgeProvisioning,
                device_bound: true,
                tenant_bound: true,
                sequence: Some(SequenceRule {
                    field: "update_seq",
                    equal: EqualSeq::Reject,
                }),
                nested: &[T::EdgeRelease, T::TrustAnchors, T::SiteConfig],
                checks: &[
                    R::KeyEpochMismatch,
                    R::NotYetValid,
                    R::Expired,
                    R::DeviceBindingMismatch,
                    R::DeviceIdMismatch,
                    R::TenantMismatch,
                    R::NonceMismatch,
                    R::BoardMismatch,
                    R::RollbackBelowFloor,
                    R::SequenceReplay,
                    R::ReleaseDigestMismatch,
                    R::ReleaseMismatch,
                    R::SiteConfigDigestMismatch,
                    R::TrustAnchorsDigestMismatch,
                ],
                agent_omits: None,
            },
            T::EdgeActivationReceipt => StatementSpec {
                signing_purpose: Purpose::EdgeProvisioning,
                device_bound: true,
                tenant_bound: true,
                sequence: None,
                nested: &[],
                checks: &[
                    R::NotYetValid,
                    R::Expired,
                    R::DeviceBindingMismatch,
                    R::DeviceIdMismatch,
                    R::TenantMismatch,
                    R::ManifestDigestMismatch,
                ],
                agent_omits: Some(&[R::KeyEpochBelowRatchet, R::ManifestDigestMismatch]),
            },
            T::TrustAnchors => StatementSpec {
                signing_purpose: Purpose::FleetRoot,
                device_bound: false,
                tenant_bound: true,
                sequence: Some(SequenceRule {
                    field: "bundle_seq",
                    equal: EqualSeq::IdenticalOnly,
                }),
                nested: &[],
                checks: &[
                    R::TenantScopeMismatch,
                    R::SequenceReplay,
                    R::AnchorNotOsPinned,
                    R::AnchorInvalid,
                ],
                agent_omits: Some(&[R::KeyEpochBelowRatchet, R::SequenceReplay]),
            },
            T::DeviceLifecycle => StatementSpec {
                signing_purpose: Purpose::DeviceLifecycle,
                device_bound: true,
                tenant_bound: true,
                sequence: Some(SequenceRule {
                    field: "update_seq",
                    equal: EqualSeq::Reject,
                }),
                nested: &[],
                checks: &[
                    R::NotYetValid,
                    R::Expired,
                    R::DeviceBindingMismatch,
                    R::DeviceIdMismatch,
                    R::TenantMismatch,
                    R::SequenceReplay,
                ],
                agent_omits: None,
            },
            T::SiteConfig => StatementSpec {
                signing_purpose: Purpose::ConfigIntegrity,
                device_bound: true,
                tenant_bound: true,
                sequence: Some(SequenceRule {
                    field: "update_seq",
                    equal: EqualSeq::IdenticalOnly,
                }),
                nested: &[T::RbacManifest],
                checks: &[
                    R::NotYetValid,
                    R::Expired,
                    R::DeviceBindingMismatch,
                    R::DeviceIdMismatch,
                    R::TenantMismatch,
                    R::SequenceReplay,
                    R::SiteFileDigestMismatch,
                    R::RbacManifestDigestMismatch,
                ],
                agent_omits: Some(&[R::KeyEpochBelowRatchet]),
            },
            T::RbacManifest => StatementSpec {
                signing_purpose: Purpose::RbacManifest,
                device_bound: false,
                tenant_bound: true,
                sequence: Some(SequenceRule {
                    field: "policy_version",
                    equal: EqualSeq::IdenticalOnly,
                }),
                nested: &[],
                checks: &[
                    R::NotYetValid,
                    R::Expired,
                    R::TenantMismatch,
                    R::SequenceReplay,
                    R::ActorKeyNotAnchored,
                ],
                agent_omits: Some(&[R::KeyEpochBelowRatchet]),
            },
        }
    }
}

string_enum!(
    /// Board vocabulary (common.schema.json `board_profile`, boards.json).
    BoardProfile {
        RevpiConnect4 => "revpi-connect4",
        Rpi4Cm4 => "rpi4-cm4",
        QemuX86_64 => "qemu-x86_64",
    }
);

string_enum!(
    /// Release architectures (common.schema.json `arch`).
    Arch {
        Aarch64 => "aarch64",
        X86_64 => "x86_64",
    }
);

string_enum!(
    /// Agent profiles (common.schema.json `agent_profile`).
    AgentProfile {
        SuderraOs => "suderra-os",
    }
);

string_enum!(
    /// Agent cargo features a Suderra OS release may carry
    /// (common.schema.json `cargo_feature`).
    CargoFeature {
        Gpio => "gpio",
        RevpiIo => "revpi-io",
        ScadaDisplay => "scada-display",
        SuderraOs => "suderra-os",
    }
);

string_enum!(
    /// Device binding methods (common.schema.json `device_binding.method`).
    BindingMethod {
        TpmEkSha256 => "tpm-ek-sha256",
        Bcm2711SerialOtpSha256 => "bcm2711-serial-otp-sha256",
        DmiProductUuidSha256 => "dmi-product-uuid-sha256",
    }
);

string_enum!(
    /// Fixed site file paths relative to the site directory
    /// (common.schema.json `site_path`).
    SitePath {
        ConfigYaml => "config.yaml",
        SitePolicyJson => "site-policy.json",
        HardwareInventoryYaml => "hardware-inventory.yaml",
        RevpiConfigRsc => "revpi/config.rsc",
    }
);

/// One row of boards.json `boards` as the agent verifier uses it.
#[derive(Debug, Clone, Copy)]
pub struct BoardSpec {
    /// Release architecture.
    pub arch: Arch,
    /// Agent profile.
    pub agent_profile: AgentProfile,
    /// Exact cargo feature set of the release.
    pub cargo_features: &'static [CargoFeature],
    /// Device binding method of the board.
    pub device_binding_method: BindingMethod,
}

impl BoardProfile {
    /// boards.json row.
    pub fn spec(self) -> BoardSpec {
        use CargoFeature as F;
        match self {
            BoardProfile::RevpiConnect4 => BoardSpec {
                arch: Arch::Aarch64,
                agent_profile: AgentProfile::SuderraOs,
                cargo_features: &[F::RevpiIo, F::ScadaDisplay, F::SuderraOs],
                device_binding_method: BindingMethod::TpmEkSha256,
            },
            BoardProfile::Rpi4Cm4 => BoardSpec {
                arch: Arch::Aarch64,
                agent_profile: AgentProfile::SuderraOs,
                cargo_features: &[F::Gpio, F::ScadaDisplay, F::SuderraOs],
                device_binding_method: BindingMethod::Bcm2711SerialOtpSha256,
            },
            BoardProfile::QemuX86_64 => BoardSpec {
                arch: Arch::X86_64,
                agent_profile: AgentProfile::SuderraOs,
                cargo_features: &[F::ScadaDisplay, F::SuderraOs],
                device_binding_method: BindingMethod::TpmEkSha256,
            },
        }
    }
}

/// artifact-naming.json `suderra_os_channel`.
pub mod naming {
    use super::{Arch, BoardProfile};

    /// Name of the single binary member of every Suderra OS release artifact.
    pub const BINARY_NAME: &str = "suderra-agent";
    /// Archive members, exactly (DEC-1.10).
    pub const ARCHIVE_MEMBERS: [&str; 1] = [BINARY_NAME];
    /// Artifact format.
    pub const FORMAT: &str = "tar.gz";
    /// Artifact name template.
    pub const ARTIFACT_TEMPLATE: &str = "suderra-agent-os-{version}-{board_profile}-{arch}.tar.gz";
    /// Release statement name template.
    pub const STATEMENT_TEMPLATE: &str = "{artifact}.release.dsse.json";

    /// Artifact name of a release (`suderra_os_channel.artifact`).
    pub fn artifact_name(version: &str, board: BoardProfile, arch: Arch) -> String {
        ARTIFACT_TEMPLATE
            .replace("{version}", version)
            .replace("{board_profile}", board.as_str())
            .replace("{arch}", arch.as_str())
    }
}
