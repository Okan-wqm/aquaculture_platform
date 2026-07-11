//! Command catalog — single metadata surface for command ingress.
//!
//! The dispatcher still owns the async handler match because the handlers are
//! methods on `CommandHandler`, but command classification lives here:
//! permission resolution, signature/legacy posture, mutating classification,
//! two-person flag, bootstrap allowance, and audit taxonomy.

use serde_json::Value;

use crate::audit::AuditAction;
use crate::authz::permission::{ModbusDeviceId, ModbusRegisterRange, Permission, TagId};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LegacyPolicy {
    /// Legacy `CommandMessage` may execute unsigned in enforcing mode.
    ///
    /// This is reserved for catalog-anonymous commands only. Any command with
    /// a permission, including read-only commands, requires a signed envelope
    /// once `SignatureMode::Enforcing` is active.
    AllowUnsignedInEnforcing,
    /// Legacy payload is accepted only outside `SignatureMode::Enforcing`.
    DenyUnsignedInEnforcing,
    /// Cataloged command is intentionally unavailable.
    DenyAlways,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StaticPermission {
    ReadTag,
    DeployProgram,
    UpdateFirmware,
    Reboot,
    SafeStateTrigger,
    FailoverControl,
    ManagePolicy,
    ManageIoConfig,
    ManageLicense,
    ManageUserTokenManifest,
    ManageCertPinning,
    WatchSubscribe,
    DebugStep,
    ForceValue,
}

impl StaticPermission {
    fn to_permission(self) -> Permission {
        match self {
            Self::ReadTag => Permission::ReadTag,
            Self::DeployProgram => Permission::DeployProgram,
            Self::UpdateFirmware => Permission::UpdateFirmware,
            Self::Reboot => Permission::Reboot,
            Self::SafeStateTrigger => Permission::SafeStateTrigger,
            Self::FailoverControl => Permission::FailoverControl,
            Self::ManagePolicy => Permission::ManagePolicy,
            Self::ManageIoConfig => Permission::ManageIoConfig,
            Self::ManageLicense => Permission::ManageLicense,
            Self::ManageUserTokenManifest => Permission::ManageUserTokenManifest,
            Self::ManageCertPinning => Permission::ManageCertPinning,
            Self::WatchSubscribe => Permission::WatchSubscribe,
            Self::DebugStep => Permission::DebugStep,
            Self::ForceValue => Permission::ForceValue,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PermissionResolver {
    Anonymous,
    Static(StaticPermission),
    WriteTagParam(&'static str),
    GpioPinParam,
    ModbusWriteParam,
    OpcUaAddressParam,
    S7AddressParam,
}

impl PermissionResolver {
    fn resolve(self, params: &Value) -> Option<Permission> {
        match self {
            Self::Anonymous => None,
            Self::Static(permission) => Some(permission.to_permission()),
            Self::WriteTagParam(field) => match string_param(params, field) {
                Some(name) => Some(Permission::WriteTag {
                    tag_id: TagId::new(name.to_string()),
                }),
                None => Some(Permission::SafeStateTrigger),
            },
            Self::GpioPinParam => match params.get("pin").and_then(|v| v.as_u64()) {
                Some(pin) if pin <= u8::MAX as u64 => {
                    Some(Permission::GpioWrite { pin: pin as u8 })
                }
                _ => Some(Permission::SafeStateTrigger),
            },
            Self::ModbusWriteParam => {
                let device_id = params
                    .get("slave_id")
                    .or_else(|| params.get("slaveId"))
                    .or_else(|| params.get("device_id"))
                    .or_else(|| params.get("deviceId"))
                    .or_else(|| params.get("unit_id"))
                    .or_else(|| params.get("unitId"))
                    .and_then(|v| v.as_u64());
                let address = params.get("address").and_then(|v| v.as_u64());
                match (device_id, address) {
                    (Some(device), Some(address))
                        if device <= u8::MAX as u64 && address <= u16::MAX as u64 =>
                    {
                        match ModbusRegisterRange::new(address as u16, address as u16) {
                            Ok(register_range) => Some(Permission::ModbusWrite {
                                device_id: ModbusDeviceId(device as u8),
                                register_range,
                            }),
                            Err(_) => Some(Permission::SafeStateTrigger),
                        }
                    }
                    _ => Some(Permission::SafeStateTrigger),
                }
            }
            Self::OpcUaAddressParam => match params
                .get("address")
                .or_else(|| params.get("node_id"))
                .or_else(|| params.get("nodeId"))
                .and_then(|v| v.as_str())
            {
                Some(address) => Some(Permission::OpcUaWrite {
                    tag_id: TagId::new(address.to_string()),
                }),
                None => Some(Permission::SafeStateTrigger),
            },
            Self::S7AddressParam => match params.get("address").and_then(|v| v.as_str()) {
                Some(address) => Some(Permission::S7Write {
                    address: TagId::new(address.to_string()),
                }),
                None => Some(Permission::SafeStateTrigger),
            },
        }
    }
}

fn string_param<'a>(params: &'a Value, field: &str) -> Option<&'a str> {
    params
        .get(field)
        .or_else(|| match field {
            "tag_name" => params.get("tagName"),
            "tagName" => params.get("tag_name"),
            _ => None,
        })
        .and_then(|v| v.as_str())
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct CommandCatalogEntry {
    pub wire_name: &'static str,
    pub handler_name: Option<&'static str>,
    pub permission: PermissionResolver,
    pub legacy_policy: LegacyPolicy,
    pub bootstrap_allowed: bool,
    pub audit_success: AuditAction,
    pub audit_failure: AuditAction,
}

impl CommandCatalogEntry {
    pub(crate) fn required_permission(self, params: &Value) -> Option<Permission> {
        self.permission.resolve(params)
    }

    pub(crate) fn is_mutating(self) -> bool {
        self.required_permission(&Value::Null)
            .as_ref()
            .map(Permission::is_mutating)
            .unwrap_or(false)
    }
}

macro_rules! entry {
    ($wire:literal, $handler:literal, $perm:expr, $legacy:expr, $bootstrap:expr, $ok:expr, $fail:expr) => {
        CommandCatalogEntry {
            wire_name: $wire,
            handler_name: Some($handler),
            permission: $perm,
            legacy_policy: $legacy,
            bootstrap_allowed: $bootstrap,
            audit_success: $ok,
            audit_failure: $fail,
        }
    };
    ($wire:literal, denied, $perm:expr, $ok:expr, $fail:expr) => {
        CommandCatalogEntry {
            wire_name: $wire,
            handler_name: None,
            permission: $perm,
            legacy_policy: LegacyPolicy::DenyAlways,
            bootstrap_allowed: false,
            audit_success: $ok,
            audit_failure: $fail,
        }
    };
}

pub(crate) const COMMAND_CATALOG: &[CommandCatalogEntry] = &[
    entry!(
        "ping",
        "cmd_ping",
        PermissionResolver::Anonymous,
        LegacyPolicy::AllowUnsignedInEnforcing,
        true,
        AuditAction::TagRead,
        AuditAction::CommandRejected
    ),
    entry!(
        "get_info",
        "cmd_get_info",
        PermissionResolver::Anonymous,
        LegacyPolicy::AllowUnsignedInEnforcing,
        true,
        AuditAction::TagRead,
        AuditAction::CommandRejected
    ),
    entry!(
        "get_config",
        "cmd_get_config",
        PermissionResolver::Static(StaticPermission::ReadTag),
        LegacyPolicy::DenyUnsignedInEnforcing,
        true,
        AuditAction::TagRead,
        AuditAction::CommandRejected
    ),
    entry!(
        "get_hardware",
        "cmd_get_hardware",
        PermissionResolver::Static(StaticPermission::ReadTag),
        LegacyPolicy::DenyUnsignedInEnforcing,
        true,
        AuditAction::TagRead,
        AuditAction::CommandRejected
    ),
    entry!(
        "scan_hardware",
        "cmd_scan_hardware",
        PermissionResolver::Static(StaticPermission::ReadTag),
        LegacyPolicy::DenyUnsignedInEnforcing,
        true,
        AuditAction::TagRead,
        AuditAction::CommandRejected
    ),
    entry!(
        "read_modbus",
        "cmd_read_modbus",
        PermissionResolver::Static(StaticPermission::ReadTag),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::TagRead,
        AuditAction::CommandRejected
    ),
    entry!(
        "read_gpio",
        "cmd_read_gpio",
        PermissionResolver::Static(StaticPermission::ReadTag),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::TagRead,
        AuditAction::CommandRejected
    ),
    entry!(
        "list_scripts",
        "cmd_list_scripts",
        PermissionResolver::Static(StaticPermission::ReadTag),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::TagRead,
        AuditAction::CommandRejected
    ),
    entry!(
        "get_script",
        "cmd_get_script",
        PermissionResolver::Static(StaticPermission::ReadTag),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::TagRead,
        AuditAction::CommandRejected
    ),
    entry!(
        "get_program",
        "cmd_get_program",
        PermissionResolver::Static(StaticPermission::ReadTag),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::TagRead,
        AuditAction::CommandRejected
    ),
    entry!(
        "plc_status",
        "cmd_plc_status",
        PermissionResolver::Static(StaticPermission::ReadTag),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::TagRead,
        AuditAction::CommandRejected
    ),
    entry!(
        "plc_list",
        "cmd_plc_list",
        PermissionResolver::Static(StaticPermission::ReadTag),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::TagRead,
        AuditAction::CommandRejected
    ),
    entry!(
        "plc_download",
        "cmd_plc_download",
        PermissionResolver::Static(StaticPermission::ReadTag),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::TagRead,
        AuditAction::CommandRejected
    ),
    entry!(
        "failover_status",
        "cmd_failover_status",
        PermissionResolver::Static(StaticPermission::ReadTag),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::TagRead,
        AuditAction::CommandRejected
    ),
    entry!(
        "get_display_status",
        "cmd_get_display_status",
        PermissionResolver::Static(StaticPermission::ReadTag),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::TagRead,
        AuditAction::CommandRejected
    ),
    entry!(
        "list_bytecode_programs",
        "cmd_list_bytecode_programs",
        PermissionResolver::Static(StaticPermission::ReadTag),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::TagRead,
        AuditAction::CommandRejected
    ),
    entry!(
        "list_forces",
        "cmd_list_forces",
        PermissionResolver::Static(StaticPermission::ReadTag),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::TagRead,
        AuditAction::CommandRejected
    ),
    entry!(
        "watch_subscribe",
        "cmd_watch_subscribe",
        PermissionResolver::Static(StaticPermission::WatchSubscribe),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::TagRead,
        AuditAction::CommandRejected
    ),
    entry!(
        "watch_unsubscribe",
        "cmd_watch_unsubscribe",
        PermissionResolver::Static(StaticPermission::WatchSubscribe),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::TagRead,
        AuditAction::CommandRejected
    ),
    entry!(
        "list_watch_sessions",
        "cmd_list_watch_sessions",
        PermissionResolver::Static(StaticPermission::WatchSubscribe),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::TagRead,
        AuditAction::CommandRejected
    ),
    entry!(
        "write_modbus",
        "cmd_write_modbus",
        PermissionResolver::ModbusWriteParam,
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::TagWrite,
        AuditAction::CommandRejected
    ),
    entry!(
        "write_gpio",
        "cmd_write_gpio",
        PermissionResolver::GpioPinParam,
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::TagWrite,
        AuditAction::CommandRejected
    ),
    entry!(
        "write_opcua",
        "cmd_write_opcua",
        PermissionResolver::OpcUaAddressParam,
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::TagWrite,
        AuditAction::CommandRejected
    ),
    entry!(
        "write_s7",
        "cmd_write_s7",
        PermissionResolver::S7AddressParam,
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::TagWrite,
        AuditAction::CommandRejected
    ),
    entry!(
        "set_output",
        "cmd_set_output",
        PermissionResolver::WriteTagParam("tag_name"),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::TagWrite,
        AuditAction::CommandRejected
    ),
    entry!(
        "update_io_config",
        "cmd_update_io_config",
        PermissionResolver::Static(StaticPermission::ManageIoConfig),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::PolicyUpdateApplied,
        AuditAction::PolicyUpdateRejected
    ),
    entry!(
        "deploy_script",
        "cmd_deploy_script",
        PermissionResolver::Static(StaticPermission::DeployProgram),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::ProgramDeployApplied,
        AuditAction::ProgramDeployRequested
    ),
    entry!(
        "deploy_program",
        "cmd_deploy_program",
        PermissionResolver::Static(StaticPermission::DeployProgram),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::ProgramDeployApplied,
        AuditAction::ProgramDeployRequested
    ),
    entry!(
        "deploy_bytecode_program",
        "cmd_deploy_bytecode_program",
        PermissionResolver::Static(StaticPermission::DeployProgram),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::ProgramDeployApplied,
        AuditAction::ProgramDeployRequested
    ),
    entry!(
        "deploy_st_source",
        "cmd_deploy_st_source",
        PermissionResolver::Static(StaticPermission::DeployProgram),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::ProgramDeployApplied,
        AuditAction::ProgramDeployRequested
    ),
    entry!(
        "deploy_to_codesys",
        "cmd_deploy_to_codesys",
        PermissionResolver::Static(StaticPermission::DeployProgram),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::ProgramDeployApplied,
        AuditAction::ProgramDeployRequested
    ),
    entry!(
        "deploy_auto",
        "cmd_deploy_auto",
        PermissionResolver::Static(StaticPermission::DeployProgram),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::ProgramDeployApplied,
        AuditAction::ProgramDeployRequested
    ),
    entry!(
        "plc_upload",
        "cmd_plc_upload",
        PermissionResolver::Static(StaticPermission::DeployProgram),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::ProgramDeployApplied,
        AuditAction::ProgramDeployRequested
    ),
    entry!(
        "rollback_program",
        "cmd_rollback_program",
        PermissionResolver::Static(StaticPermission::DeployProgram),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::ProgramDeployRollback,
        AuditAction::CommandRejected
    ),
    entry!(
        "delete_script",
        "cmd_delete_script",
        PermissionResolver::Static(StaticPermission::DeployProgram),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::ProgramDeployRollback,
        AuditAction::CommandRejected
    ),
    entry!(
        "enable_script",
        "cmd_enable_script",
        PermissionResolver::Static(StaticPermission::DeployProgram),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::ProgramDeployApplied,
        AuditAction::ProgramDeployRequested
    ),
    entry!(
        "disable_script",
        "cmd_disable_script",
        PermissionResolver::Static(StaticPermission::DeployProgram),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::ProgramDeployRollback,
        AuditAction::CommandRejected
    ),
    entry!(
        "plc_start",
        "cmd_plc_start",
        PermissionResolver::Static(StaticPermission::DeployProgram),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::ProgramDeployApplied,
        AuditAction::ProgramDeployRequested
    ),
    entry!(
        "plc_stop",
        "cmd_plc_stop",
        PermissionResolver::Static(StaticPermission::DeployProgram),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::ProgramDeployRollback,
        AuditAction::CommandRejected
    ),
    entry!(
        "plc_delete",
        "cmd_plc_delete",
        PermissionResolver::Static(StaticPermission::DeployProgram),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::ProgramDeployRollback,
        AuditAction::CommandRejected
    ),
    entry!(
        "validate_st",
        "cmd_validate_st",
        PermissionResolver::Static(StaticPermission::DeployProgram),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::ProgramDeployRequested,
        AuditAction::CommandRejected
    ),
    entry!(
        "enable_bytecode_program",
        "cmd_enable_bytecode_program",
        PermissionResolver::Static(StaticPermission::DeployProgram),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::ProgramDeployApplied,
        AuditAction::ProgramDeployRequested
    ),
    entry!(
        "disable_bytecode_program",
        "cmd_disable_bytecode_program",
        PermissionResolver::Static(StaticPermission::DeployProgram),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::ProgramDeployRollback,
        AuditAction::CommandRejected
    ),
    entry!(
        "delete_bytecode_program",
        "cmd_delete_bytecode_program",
        PermissionResolver::Static(StaticPermission::DeployProgram),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::ProgramDeployRollback,
        AuditAction::CommandRejected
    ),
    entry!(
        "reboot",
        "cmd_reboot",
        PermissionResolver::Static(StaticPermission::Reboot),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::CommandExecuted,
        AuditAction::CommandRejected
    ),
    entry!(
        "restart_agent",
        "cmd_restart_agent",
        PermissionResolver::Static(StaticPermission::Reboot),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::CommandExecuted,
        AuditAction::CommandRejected
    ),
    entry!(
        "update_firmware",
        "cmd_update_firmware",
        PermissionResolver::Static(StaticPermission::UpdateFirmware),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::FirmwareDeployApplied,
        AuditAction::FirmwareDeployRequested
    ),
    entry!(
        "confirm_slot",
        "cmd_confirm_slot",
        PermissionResolver::Static(StaticPermission::UpdateFirmware),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::FirmwareDeployApplied,
        AuditAction::FirmwareDeployRequested
    ),
    entry!(
        "verify_signed_manifest",
        "cmd_verify_signed_manifest",
        PermissionResolver::Static(StaticPermission::UpdateFirmware),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::FirmwareDeployRequested,
        AuditAction::FirmwareDeployRequested
    ),
    entry!(
        "apply_signed_manifest",
        "cmd_apply_signed_manifest",
        PermissionResolver::Static(StaticPermission::UpdateFirmware),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::FirmwareDeployApplied,
        AuditAction::FirmwareDeployRequested
    ),
    entry!(
        "set_log_level",
        "cmd_set_log_level",
        PermissionResolver::Static(StaticPermission::ManagePolicy),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::CommandExecuted,
        AuditAction::CommandRejected
    ),
    entry!(
        "failover_force",
        "cmd_failover_force",
        PermissionResolver::Static(StaticPermission::FailoverControl),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::CommandExecuted,
        AuditAction::CommandRejected
    ),
    entry!(
        "failover_recover",
        "cmd_failover_recover",
        PermissionResolver::Static(StaticPermission::FailoverControl),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::CommandExecuted,
        AuditAction::CommandRejected
    ),
    entry!(
        "deploy_process",
        "cmd_deploy_process",
        PermissionResolver::Static(StaticPermission::DeployProgram),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::ProgramDeployApplied,
        AuditAction::ProgramDeployRequested
    ),
    entry!(
        "deploy_scada_package",
        "cmd_deploy_scada_package",
        PermissionResolver::Static(StaticPermission::DeployProgram),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::ProgramDeployApplied,
        AuditAction::ProgramDeployRequested
    ),
    // A release bundle is the transactional grouping of the SAME artifacts
    // deploy_process / deploy_scada_package / deploy_program apply, so it takes
    // the identical DeployProgram permission class and ProgramDeploy audit
    // taxonomy as its sibling deploy_scada_package (both are integrity-gated by
    // a REQUIRED ed25519 manifest signature + tenant binding + per-artifact
    // checksum + verify-before-apply staging). EDGE-HIGH-003: cmd_deploy_bundle
    // had a dispatch arm (dispatch_lifecycle.rs) but no catalog entry, so every
    // catalog lookup fell through to its .unwrap_or fallback — resolving the
    // command to the SafeStateTrigger permission (wrong RBAC class for a deploy)
    // and, critically, to NO audit action (audit_action_for_command returns None
    // for an uncataloged command), so a bundle apply left no ProgramDeploy audit
    // record. This entry gives deploy_bundle the same permission + audit + legacy
    // policy as the parts it groups.
    entry!(
        "deploy_bundle",
        "cmd_deploy_bundle",
        PermissionResolver::Static(StaticPermission::DeployProgram),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::ProgramDeployApplied,
        AuditAction::ProgramDeployRequested
    ),
    entry!(
        "display_on",
        "cmd_display_on",
        PermissionResolver::Static(StaticPermission::DeployProgram),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::ProgramDeployApplied,
        AuditAction::ProgramDeployRequested
    ),
    entry!(
        "display_off",
        "cmd_display_off",
        PermissionResolver::Static(StaticPermission::DeployProgram),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::ProgramDeployRollback,
        AuditAction::CommandRejected
    ),
    entry!(
        "update_lora_devices",
        "cmd_update_lora_devices",
        PermissionResolver::Static(StaticPermission::ManagePolicy),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::PolicyUpdateApplied,
        AuditAction::PolicyUpdateRejected
    ),
    entry!(
        "lora_downlink",
        "cmd_lora_downlink",
        PermissionResolver::Static(StaticPermission::SafeStateTrigger),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::TagWrite,
        AuditAction::CommandRejected
    ),
    entry!(
        "update_policy",
        "cmd_update_policy",
        PermissionResolver::Static(StaticPermission::ManagePolicy),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::PolicyUpdateApplied,
        AuditAction::PolicyUpdateRejected
    ),
    entry!(
        "update_user_token_manifest",
        "cmd_update_user_token_manifest",
        PermissionResolver::Static(StaticPermission::ManageUserTokenManifest),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::PolicyUpdateApplied,
        AuditAction::PolicyUpdateRejected
    ),
    entry!(
        "rotate_master",
        "cmd_rotate_master",
        PermissionResolver::Static(StaticPermission::ManagePolicy),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::MasterKeyRotated,
        AuditAction::CommandRejected
    ),
    entry!(
        "refresh_license",
        "cmd_refresh_license",
        PermissionResolver::Static(StaticPermission::ManageLicense),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::PolicyUpdateApplied,
        AuditAction::PolicyUpdateRejected
    ),
    entry!(
        "force_value",
        "cmd_force_value",
        PermissionResolver::Static(StaticPermission::ForceValue),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::ForceValueApplied,
        AuditAction::CommandRejected
    ),
    entry!(
        "unforce_value",
        "cmd_unforce_value",
        PermissionResolver::Static(StaticPermission::ForceValue),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::ForceValueRevoked,
        AuditAction::CommandRejected
    ),
    entry!(
        "unforce_all",
        "cmd_unforce_all",
        PermissionResolver::Static(StaticPermission::ForceValue),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::ForceValueRevoked,
        AuditAction::CommandRejected
    ),
    entry!(
        "update_cert_pinning",
        "cmd_update_cert_pinning",
        PermissionResolver::Static(StaticPermission::ManageCertPinning),
        LegacyPolicy::DenyUnsignedInEnforcing,
        false,
        AuditAction::MqttCertRotated,
        AuditAction::CommandRejected
    ),
    entry!(
        "debug_step",
        denied,
        PermissionResolver::Static(StaticPermission::DebugStep),
        AuditAction::CommandExecuted,
        AuditAction::CommandRejected
    ),
];

pub(crate) const MUTATING_WIRE_NAMES: &[&str] = &[
    "apply_signed_manifest",
    "confirm_slot",
    "debug_step",
    "delete_bytecode_program",
    "delete_script",
    "deploy_auto",
    "deploy_bundle",
    "deploy_bytecode_program",
    "deploy_process",
    "deploy_program",
    "deploy_scada_package",
    "deploy_script",
    "deploy_st_source",
    "deploy_to_codesys",
    "disable_bytecode_program",
    "disable_script",
    "display_off",
    "display_on",
    "enable_bytecode_program",
    "enable_script",
    "failover_force",
    "failover_recover",
    "force_value",
    "lora_downlink",
    "plc_delete",
    "plc_start",
    "plc_stop",
    "plc_upload",
    "reboot",
    "refresh_license",
    "restart_agent",
    "rollback_program",
    "rotate_master",
    "set_log_level",
    "set_output",
    "unforce_all",
    "unforce_value",
    "update_cert_pinning",
    "update_firmware",
    "update_io_config",
    "update_lora_devices",
    "update_policy",
    "update_user_token_manifest",
    "validate_st",
    "verify_signed_manifest",
    "write_gpio",
    "write_modbus",
    "write_opcua",
    "write_s7",
];

pub(crate) fn entry_for_command(cmd: &str) -> Option<&'static CommandCatalogEntry> {
    COMMAND_CATALOG.iter().find(|entry| entry.wire_name == cmd)
}

pub(crate) fn permission_for_command(cmd: &str, params: &Value) -> Option<Permission> {
    entry_for_command(cmd)
        .map(|entry| entry.required_permission(params))
        .unwrap_or(Some(Permission::SafeStateTrigger))
}

pub(crate) fn is_mutating_command(cmd: &str) -> bool {
    entry_for_command(cmd)
        .map(|entry| entry.is_mutating())
        .unwrap_or(true)
}

pub(crate) fn legacy_policy_for_command(cmd: &str) -> LegacyPolicy {
    entry_for_command(cmd)
        .map(|entry| entry.legacy_policy)
        .unwrap_or(LegacyPolicy::DenyUnsignedInEnforcing)
}

/// Decide whether an UNSIGNED legacy `CommandMessage` (the
/// envelope-adapter `NotEnvelopeFormat` path) may execute under the
/// active `signature_mode`. Returns `Err(reason)` when the command
/// must be rejected.
///
/// EDGE-CRITICAL-003: before this wiring the legacy dispatch arm
/// executed with zero signature/mode/legacy-policy check, so an
/// unsigned mutating command (`write_modbus`/`set_output`/…) bypassed
/// `SignatureMode::Enforcing` entirely. The legacy JSON path carries
/// no signature, so this mirrors `verify_envelope` Gate 7 for the
/// unsigned case:
///
/// - `Disabled` — HC-1 auth-off: accept everything (matches the
///   envelope path's `(Disabled, _, _) => {}`).
/// - `DenyUnsignedInEnforcing` — rejected in Enforcing; accepted in
///   Permissive (the caller logs it, mirroring the envelope posture).
/// - `DenyAlways` — never permitted on the unsigned path outside
///   Disabled.
/// - `AllowUnsignedInEnforcing` — catalog-anonymous (ping/get_info);
///   always permitted.
pub(crate) fn legacy_command_permitted(
    cmd: &str,
    mode: crate::command_envelope::envelope::SignatureMode,
) -> Result<(), &'static str> {
    use crate::command_envelope::envelope::SignatureMode;
    // Signature system explicitly off — the envelope path also
    // accepts everything under Disabled (HC-1 backward compat).
    if matches!(mode, SignatureMode::Disabled) {
        return Ok(());
    }
    match legacy_policy_for_command(cmd) {
        LegacyPolicy::AllowUnsignedInEnforcing => Ok(()),
        LegacyPolicy::DenyUnsignedInEnforcing => match mode {
            SignatureMode::Enforcing => {
                Err("unsigned legacy command rejected in signature_mode=enforcing")
            }
            // Permissive (Disabled already returned above): accept,
            // caller logs — mirrors the envelope Permissive posture.
            _ => Ok(()),
        },
        LegacyPolicy::DenyAlways => Err("command is never permitted on the unsigned legacy path"),
    }
}

pub(crate) fn handler_name_for_command(cmd: &str) -> Option<&'static str> {
    entry_for_command(cmd).and_then(|entry| entry.handler_name)
}

pub(crate) fn is_bootstrap_allowed_command(cmd: &str) -> bool {
    entry_for_command(cmd)
        .map(|entry| entry.bootstrap_allowed)
        .unwrap_or(false)
}

pub(crate) fn audit_action_for_command(cmd: &str, success: bool) -> Option<AuditAction> {
    entry_for_command(cmd).map(|entry| {
        if success {
            entry.audit_success
        } else {
            entry.audit_failure
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mutating_wire_names_are_sorted() {
        for pair in MUTATING_WIRE_NAMES.windows(2) {
            assert!(pair[0] < pair[1], "not sorted: {} >= {}", pair[0], pair[1]);
        }
    }

    #[test]
    fn every_mutating_name_is_cataloged_as_mutating() {
        for cmd in MUTATING_WIRE_NAMES {
            let entry = entry_for_command(cmd).unwrap_or_else(|| panic!("{cmd} missing"));
            assert!(
                entry.is_mutating(),
                "{cmd} must resolve to mutating permission"
            );
        }
    }

    #[test]
    fn catalog_mutating_entries_are_in_mutating_names() {
        for entry in COMMAND_CATALOG {
            if entry.is_mutating() {
                assert!(
                    MUTATING_WIRE_NAMES.binary_search(&entry.wire_name).is_ok(),
                    "{} mutating but absent from MUTATING_WIRE_NAMES",
                    entry.wire_name
                );
            }
        }
    }

    #[test]
    fn debug_step_is_explicitly_denied() {
        let entry = entry_for_command("debug_step").expect("cataloged");
        assert!(entry.handler_name.is_none());
        assert_eq!(entry.legacy_policy, LegacyPolicy::DenyAlways);
        assert!(entry.is_mutating());
    }

    #[test]
    fn only_anonymous_commands_allow_unsigned_legacy_in_enforcing() {
        for entry in COMMAND_CATALOG {
            if matches!(entry.legacy_policy, LegacyPolicy::AllowUnsignedInEnforcing) {
                assert!(
                    matches!(entry.permission, PermissionResolver::Anonymous),
                    "{} allows unsigned legacy enforcing without being anonymous",
                    entry.wire_name
                );
            }
            if matches!(entry.permission, PermissionResolver::Anonymous) {
                assert_eq!(
                    entry.legacy_policy,
                    LegacyPolicy::AllowUnsignedInEnforcing,
                    "{} is anonymous but legacy policy is not explicit",
                    entry.wire_name
                );
            }
        }
    }

    #[test]
    fn legacy_command_permitted_enforces_signature_mode() {
        use crate::command_envelope::envelope::SignatureMode;

        // Representative commands by policy, discovered from the
        // catalog so the test does not hardcode wire names.
        let mut anon = "";
        let mut mutating = "";
        for e in COMMAND_CATALOG {
            if anon.is_empty()
                && matches!(e.legacy_policy, LegacyPolicy::AllowUnsignedInEnforcing)
            {
                anon = e.wire_name;
            }
            if mutating.is_empty()
                && matches!(e.legacy_policy, LegacyPolicy::DenyUnsignedInEnforcing)
            {
                mutating = e.wire_name;
            }
        }
        assert!(
            !anon.is_empty() && !mutating.is_empty(),
            "catalog must have both an anonymous and a deny-unsigned command"
        );

        // EDGE-CRITICAL-003: the core gate — an unsigned mutating
        // command is REJECTED in Enforcing (previously it dispatched
        // with no signature check at all).
        assert!(legacy_command_permitted(mutating, SignatureMode::Enforcing).is_err());
        // Permissive accepts (caller logs), mirroring the envelope path.
        assert!(legacy_command_permitted(mutating, SignatureMode::Permissive).is_ok());
        // Disabled = auth off (HC-1): accepted.
        assert!(legacy_command_permitted(mutating, SignatureMode::Disabled).is_ok());

        // Anonymous bootstrap commands (ping/get_info) run unsigned in
        // every mode.
        for mode in [
            SignatureMode::Disabled,
            SignatureMode::Permissive,
            SignatureMode::Enforcing,
        ] {
            assert!(
                legacy_command_permitted(anon, mode).is_ok(),
                "anonymous command must run unsigned in {:?}",
                mode
            );
        }

        // Unknown commands fail closed (DenyUnsignedInEnforcing
        // default) → rejected in Enforcing.
        assert!(legacy_command_permitted("totally_unknown_cmd_xyz", SignatureMode::Enforcing).is_err());
    }

    #[test]
    fn update_cert_pinning_requires_manage_cert_pinning() {
        let p = permission_for_command("update_cert_pinning", &Value::Null);
        assert!(matches!(p, Some(Permission::ManageCertPinning)));
    }

    #[test]
    fn write_s7_uses_s7_write_permission() {
        let p = permission_for_command("write_s7", &serde_json::json!({"address": "DB1.DBW0"}));
        assert!(matches!(p, Some(Permission::S7Write { .. })));
    }

    #[test]
    fn write_modbus_uses_register_scoped_permission() {
        let p = permission_for_command(
            "write_modbus",
            &serde_json::json!({"slave_id": 10, "address": 123, "value": 1}),
        );
        match p {
            Some(Permission::ModbusWrite {
                device_id,
                register_range,
            }) => {
                assert_eq!(device_id.0, 10);
                assert_eq!(register_range.start(), 123);
                assert_eq!(register_range.end(), 123);
            }
            other => panic!("expected ModbusWrite, got {other:?}"),
        }
    }

    #[test]
    fn write_modbus_malformed_params_fail_closed() {
        let p = permission_for_command(
            "write_modbus",
            &serde_json::json!({"device": "pump-a", "value": 1}),
        );
        assert!(matches!(p, Some(Permission::SafeStateTrigger)));
    }

    #[test]
    fn update_io_config_uses_dedicated_permission() {
        let p = permission_for_command("update_io_config", &Value::Null);
        assert!(matches!(p, Some(Permission::ManageIoConfig)));
    }

    #[test]
    fn refresh_license_uses_license_permission() {
        let p = permission_for_command("refresh_license", &Value::Null);
        assert!(matches!(p, Some(Permission::ManageLicense)));
    }

    /// EDGE-HIGH-003 regression: cmd_deploy_bundle has a dispatch arm but for a
    /// while had no catalog entry, so the command resolved through the .unwrap_or
    /// fallbacks — SafeStateTrigger permission (wrong RBAC class) and NO audit
    /// action (a bundle apply left no ProgramDeploy audit record). It must now
    /// resolve to exactly the same permission + audit + legacy policy as the
    /// sibling deploy_scada_package whose artifacts it groups.
    #[test]
    fn deploy_bundle_resolves_like_deploy_scada_package() {
        let bundle = entry_for_command("deploy_bundle").expect("deploy_bundle must be cataloged");
        let scada =
            entry_for_command("deploy_scada_package").expect("deploy_scada_package cataloged");

        // Deploy permission class (DeployProgram), not the SafeStateTrigger fallback.
        assert!(matches!(
            permission_for_command("deploy_bundle", &Value::Null),
            Some(Permission::DeployProgram)
        ));
        // Audit taxonomy present and identical to the parts it groups.
        assert_eq!(bundle.audit_success, scada.audit_success);
        assert_eq!(bundle.audit_failure, scada.audit_failure);
        assert_eq!(
            audit_action_for_command("deploy_bundle", true),
            Some(AuditAction::ProgramDeployApplied)
        );
        // Same signature-enforcement floor as its parts.
        assert_eq!(bundle.legacy_policy, scada.legacy_policy);
        assert_eq!(
            legacy_policy_for_command("deploy_bundle"),
            LegacyPolicy::DenyUnsignedInEnforcing
        );
    }
}
