//! The target of a `write_modbus` command, parsed once (ADR-048 DEC-9.7;
//! EDGE-HIGH-063).
//!
//! The command used to name its target twice. The permission the RBAC engine
//! checked came from `params.slave_id` and `params.address`; the handler wrote
//! to the device named by `params.device`. Nothing tied the two together, so
//! an operator granted `ModbusWrite` for slave 5 could write any device by
//! name, and the cloud's own VFD writes, which carry a device name and no slave
//! id, never produced the permission they needed.
//!
//! [`ModbusWriteTarget::resolve`] reads both against the configured devices
//! and answers with the one device the command means, or says why there is
//! none:
//!
//! * a device name names one configured device, and when the command also
//!   carries a slave id it must be that device's;
//! * a slave id alone must be owned by exactly one device (two devices that
//!   share a unit id are ambiguous);
//! * the address is required.
//!
//! The dispatch path rewrites the verified command's parameters with the
//! resolved target ([`ModbusWriteTarget::canonical_params`]) before the
//! permission is derived, so the authorization subject and the write are the
//! same fields by construction, and the handler resolves again from the
//! configuration so a path that skips the dispatcher cannot name a different
//! device either.

use serde_json::{Value, json};

use crate::config::ModbusDeviceConfig;

/// The one device and register a `write_modbus` command writes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ModbusWriteTarget {
    pub slave_id: u8,
    pub address: u16,
    pub device: String,
}

/// Why a `write_modbus` command names no single device.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub(crate) enum TargetError {
    #[error("write_modbus needs a 'device' name or a 'slave_id'")]
    NoDevice,
    #[error("write_modbus needs an 'address' (0 to 65535)")]
    NoAddress,
    #[error("no Modbus device is configured with the name '{0}'")]
    UnknownDevice(String),
    #[error("more than one Modbus device is configured with the name '{0}'")]
    DuplicateName(String),
    #[error(
        "the command names device '{device}' (slave id {device_slave}) and slave id {slave_id}: \
         they are different devices"
    )]
    Mismatch {
        device: String,
        device_slave: u8,
        slave_id: u8,
    },
    #[error("no Modbus device is configured for slave id {0}")]
    UnknownSlave(u8),
    #[error("slave id {slave_id} belongs to more than one Modbus device ({devices}); name one")]
    AmbiguousSlave { slave_id: u8, devices: String },
}

/// The keys a slave id travels under (the cloud and the HMI use different
/// spellings; the permission resolver reads the same list).
const SLAVE_KEYS: [&str; 6] = [
    "slave_id",
    "slaveId",
    "device_id",
    "deviceId",
    "unit_id",
    "unitId",
];

impl ModbusWriteTarget {
    /// Resolve the target the parameters name against the configured devices.
    pub(crate) fn resolve(
        params: &Value,
        devices: &[ModbusDeviceConfig],
    ) -> Result<Self, TargetError> {
        let slave_id = SLAVE_KEYS
            .iter()
            .find_map(|key| params.get(*key))
            .and_then(Value::as_u64)
            .and_then(|v| u8::try_from(v).ok());
        let address = params
            .get("address")
            .and_then(Value::as_u64)
            .and_then(|v| u16::try_from(v).ok())
            .ok_or(TargetError::NoAddress)?;
        let name = params.get("device").and_then(Value::as_str);

        let device = match (name, slave_id) {
            (None, None) => return Err(TargetError::NoDevice),
            (Some(name), requested) => {
                let mut named = devices.iter().filter(|d| d.name == name);
                let device = named
                    .next()
                    .ok_or_else(|| TargetError::UnknownDevice(name.to_owned()))?;
                if named.next().is_some() {
                    return Err(TargetError::DuplicateName(name.to_owned()));
                }
                if let Some(slave_id) = requested
                    && slave_id != device.slave_id
                {
                    return Err(TargetError::Mismatch {
                        device: device.name.clone(),
                        device_slave: device.slave_id,
                        slave_id,
                    });
                }
                device
            }
            (None, Some(slave_id)) => {
                let mut owners = devices.iter().filter(|d| d.slave_id == slave_id);
                let first = owners.next().ok_or(TargetError::UnknownSlave(slave_id))?;
                match owners.next() {
                    None => first,
                    Some(second) => {
                        return Err(TargetError::AmbiguousSlave {
                            slave_id,
                            devices: [first, second]
                                .iter()
                                .map(|d| d.name.as_str())
                                .chain(owners.map(|d| d.name.as_str()))
                                .collect::<Vec<_>>()
                                .join(", "),
                        });
                    }
                }
            }
        };
        Ok(Self {
            slave_id: device.slave_id,
            address,
            device: device.name.clone(),
        })
    }

    /// The command's parameters with the resolved target written into them
    /// (every other member is kept): the permission is derived from these, and
    /// so is the write.
    pub(crate) fn canonical_params(&self, params: &Value) -> Value {
        let mut canonical = params.clone();
        if let Some(members) = canonical.as_object_mut() {
            for key in SLAVE_KEYS {
                members.remove(key);
            }
            members.insert("slave_id".into(), json!(self.slave_id));
            members.insert("device".into(), json!(self.device));
            members.insert("address".into(), json!(self.address));
        }
        canonical
    }
}

/// Resolve the parameters of `command` against `devices` when the command
/// names a Modbus target; every other command passes unchanged.
pub(crate) fn canonicalise(
    command: &str,
    params: &Value,
    devices: &[ModbusDeviceConfig],
) -> Result<Value, TargetError> {
    if command == "write_modbus" {
        Ok(ModbusWriteTarget::resolve(params, devices)?.canonical_params(params))
    } else {
        Ok(params.clone())
    }
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use crate::authz::permission::{ModbusDeviceId, Permission};
    use crate::commands::catalog::permission_for_command;

    fn devices() -> Vec<ModbusDeviceConfig> {
        let yaml = |name: &str, slave: u8| {
            serde_yaml::from_str::<ModbusDeviceConfig>(&format!(
                "name: \"{name}\"\nconnection_type: tcp\naddress: \"10.0.0.{slave}:502\"\n\
                 slave_id: {slave}\nregisters: []\n"
            ))
            .unwrap()
        };
        vec![
            yaml("pump-1", 5),
            yaml("pump-2", 3),
            yaml("twin-a", 9),
            yaml("twin-b", 9),
        ]
    }

    fn modbus_write(permission: Option<Permission>) -> (ModbusDeviceId, u16) {
        match permission {
            Some(Permission::ModbusWrite {
                device_id,
                register_range,
            }) => (device_id, register_range.start()),
            other => panic!("expected ModbusWrite, got {other:?}"),
        }
    }

    /// EDGE-HIGH-063: a grant for slave 5 must not write device "pump-2".
    #[test]
    fn the_authorized_subject_and_the_written_device_are_one_resolution() {
        let devices = devices();
        // The cloud's own shape: a device name, no slave id.
        let by_name = json!({"device": "pump-2", "address": 40, "value": 7});
        let canonical = canonicalise("write_modbus", &by_name, &devices).unwrap();
        let (subject, address) = modbus_write(permission_for_command("write_modbus", &canonical));
        assert_eq!(
            subject,
            ModbusDeviceId(3),
            "pump-2 is slave 3, whoever's grant"
        );
        assert_eq!(address, 40);
        assert_eq!(canonical["device"], "pump-2");

        // A command that claims slave 5 (where the grant is) but names pump-2.
        let forged = json!({"slave_id": 5, "device": "pump-2", "address": 40, "value": 7});
        assert_eq!(
            canonicalise("write_modbus", &forged, &devices),
            Err(TargetError::Mismatch {
                device: "pump-2".into(),
                device_slave: 3,
                slave_id: 5
            })
        );

        // The same device by slave id alone: the subject is the same.
        let by_slave = json!({"slaveId": 5, "address": 40, "value": 7});
        let canonical = canonicalise("write_modbus", &by_slave, &devices).unwrap();
        assert_eq!(canonical["device"], "pump-1");
        let (subject, _) = modbus_write(permission_for_command("write_modbus", &canonical));
        assert_eq!(subject, ModbusDeviceId(5));
    }

    #[test]
    fn a_target_that_names_no_single_device_is_refused() {
        let devices = devices();
        let cases = [
            (json!({"address": 1}), TargetError::NoDevice),
            (json!({"device": "pump-1"}), TargetError::NoAddress),
            (
                json!({"device": "pump-1", "address": 70000}),
                TargetError::NoAddress,
            ),
            (
                json!({"device": "ghost", "address": 1}),
                TargetError::UnknownDevice("ghost".into()),
            ),
            (
                json!({"slave_id": 77, "address": 1}),
                TargetError::UnknownSlave(77),
            ),
            (
                json!({"slave_id": 9, "address": 1}),
                TargetError::AmbiguousSlave {
                    slave_id: 9,
                    devices: "twin-a, twin-b".into(),
                },
            ),
        ];
        for (params, expected) in cases {
            assert_eq!(
                ModbusWriteTarget::resolve(&params, &devices),
                Err(expected),
                "{params}"
            );
        }
        // Two devices that share a slave id are told apart by name.
        let named = json!({"device": "twin-b", "slave_id": 9, "address": 1});
        assert_eq!(
            ModbusWriteTarget::resolve(&named, &devices).unwrap(),
            ModbusWriteTarget {
                slave_id: 9,
                address: 1,
                device: "twin-b".into()
            }
        );
    }

    #[test]
    fn a_duplicate_device_name_is_refused() {
        let mut devices = devices();
        devices.push(devices[0].clone());
        assert_eq!(
            ModbusWriteTarget::resolve(&json!({"device": "pump-1", "address": 1}), &devices),
            Err(TargetError::DuplicateName("pump-1".into()))
        );
    }

    /// Only `write_modbus` names a Modbus target; every other command's
    /// parameters pass through untouched.
    #[test]
    fn other_commands_are_not_rewritten() {
        let params = json!({"pin": 17, "state": "high"});
        assert_eq!(
            canonicalise("write_gpio", &params, &devices()).unwrap(),
            params
        );
    }

    /// The canonical form keeps the command's other members and carries one
    /// spelling of the slave id.
    #[test]
    fn the_canonical_params_carry_one_slave_id_spelling_and_keep_the_rest() {
        let canonical = canonicalise(
            "write_modbus",
            &json!({"unitId": 3, "device_id": 3, "device": "pump-2", "address": 2, "value": 9, "x": 1}),
            &devices(),
        )
        .unwrap();
        assert_eq!(
            canonical,
            json!({"slave_id": 3, "device": "pump-2", "address": 2, "value": 9, "x": 1})
        );
    }
}
