#![allow(clippy::expect_used, clippy::panic, clippy::unwrap_used)]
//! ADR-048 DEC-1.9, DEC-21, DEC-25: the generic-Linux reference unit
//! (`sens-api-gateway/systemd/suderra-agent.service`) satisfies the `generic`
//! profile of `contracts/suderra-edge/v1/unit-directives.json`.
//!
//! Units are parsed into (section, key, values) by the contract's parsing
//! rules and compared as sets, never as text (unit-directives.json
//! `description`). The checker below implements those rules; it is first held
//! to every golden unit fixture of the contract (each valid unit passes, each
//! broken unit fails for exactly its labelled violations), so a checker bug
//! cannot let the reference unit through. The reference unit must then pass
//! with no violation. Before this gate the unit granted `/dev/watchdog`,
//! `/dev/tpm0`, `/dev/tpmrm0` and `CAP_NET_BIND_SERVICE`, and hard-required
//! `time-sync.target` (EI-042, DEC-1.8, DEC-6.6, DEC-7.4, DEC-21).

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use regex::Regex;
use serde_json::Value;

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn contract_dir() -> PathBuf {
    manifest_dir().join("../contracts/suderra-edge/v1")
}

fn read_json(path: &Path) -> Value {
    let bytes =
        std::fs::read(path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    serde_json::from_slice(&bytes)
        .unwrap_or_else(|e| panic!("{} is not JSON: {e}", path.display()))
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap_or_else(|| panic!("expected an array, got {value}"))
        .iter()
        .map(|v| {
            v.as_str()
                .unwrap_or_else(|| panic!("expected a string, got {v}"))
                .to_owned()
        })
        .collect()
}

/// A unit or drop-in parsed by unit-directives.json `parsing`.
struct ParsedUnit {
    sections: BTreeMap<String, BTreeMap<String, Vec<String>>>,
    resets: BTreeSet<String>,
}

struct Rules {
    file: Value,
    list_keys: BTreeSet<String>,
    ordered_keys: BTreeSet<String>,
    empty_value_keys: BTreeSet<String>,
}

impl Rules {
    fn load() -> Self {
        let file = read_json(&contract_dir().join("unit-directives.json"));
        let parsing = &file["parsing"];
        let set = |name: &str| strings(&parsing[name]).into_iter().collect();
        Self {
            list_keys: set("list_keys"),
            ordered_keys: set("ordered_keys"),
            empty_value_keys: set("empty_value_keys"),
            file,
        }
    }

    /// `parsing.rule` and `parsing.reset_rule`.
    fn parse(&self, text: &str) -> ParsedUnit {
        let mut sections: BTreeMap<String, BTreeMap<String, Vec<String>>> = BTreeMap::new();
        let mut resets = BTreeSet::new();
        let mut section: Option<String> = None;
        for raw in text.lines() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
                continue;
            }
            if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
                assert!(
                    !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphabetic()),
                    "unparseable section header {line:?}"
                );
                sections.entry(name.to_owned()).or_default();
                section = Some(name.to_owned());
                continue;
            }
            let current = section
                .as_ref()
                .unwrap_or_else(|| panic!("assignment outside a section: {line:?}"));
            let (key, value) = line
                .split_once('=')
                .unwrap_or_else(|| panic!("unparseable unit line {line:?}"));
            let key = key.trim();
            assert!(!key.is_empty(), "unparseable unit line {line:?}");
            let value = value.trim();
            let values = sections
                .entry(current.clone())
                .or_default()
                .entry(key.to_owned())
                .or_default();
            if value.is_empty() {
                // systemd: an empty assignment resets everything accumulated
                // for the key; for empty_value_keys it is itself the value.
                values.clear();
                if !self.empty_value_keys.contains(key) {
                    resets.insert(format!("{current}.{key}"));
                }
                continue;
            }
            if self.list_keys.contains(key) {
                values.extend(value.split_ascii_whitespace().map(str::to_owned));
            } else {
                values.push(value.to_owned());
            }
        }
        ParsedUnit { sections, resets }
    }

    fn section_values(source: &Value, section: &str) -> BTreeMap<String, Vec<String>> {
        source
            .get(section)
            .and_then(Value::as_object)
            .map(|block| {
                block
                    .iter()
                    .map(|(k, v)| (k.clone(), strings(v)))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn section_keys(source: &Value, section: &str) -> Vec<String> {
        match source.get(section) {
            Some(Value::Array(_)) => strings(&source[section]),
            Some(Value::Object(block)) => block.keys().cloned().collect(),
            _ => Vec::new(),
        }
    }

    /// The violations of one unit (plus its board drop-in for the
    /// suderra-os profile), as `<category>:<Section>.<Key>`.
    fn check(
        &self,
        profile: &str,
        unit_text: &str,
        dropin_text: Option<&str>,
        board: Option<&str>,
    ) -> BTreeSet<String> {
        let mut violations = BTreeSet::new();
        let profile_spec = &self.file["profiles"][profile];
        assert!(profile_spec.is_object(), "unknown profile {profile}");
        let forbidden: Vec<&Value> = self.file["forbidden"]
            .as_array()
            .expect("forbidden")
            .iter()
            .filter(|rule| {
                rule.get("profiles")
                    .is_none_or(|p| strings(p).iter().any(|name| name == profile))
            })
            .collect();
        let key_level: BTreeSet<String> = forbidden
            .iter()
            .filter(|rule| rule.get("value_pattern").is_none())
            .map(|rule| {
                format!(
                    "{}.{}",
                    rule["section"].as_str().expect("section"),
                    rule["key"].as_str().expect("key")
                )
            })
            .collect();
        let apply_forbidden =
            |violations: &mut BTreeSet<String>, section: &str, name: &str, values: &[String]| {
                for rule in &forbidden {
                    if rule["section"] != section || rule["key"] != name {
                        continue;
                    }
                    let hit = match rule.get("value_pattern").and_then(Value::as_str) {
                        None => true,
                        Some(pattern) => {
                            let re = Regex::new(pattern).expect("value_pattern");
                            values.iter().any(|v| re.is_match(v))
                        }
                    };
                    if hit {
                        violations.insert(format!("forbidden:{section}.{name}"));
                    }
                }
            };

        let unit = self.parse(unit_text);
        let mut guarded = BTreeSet::new();
        let empty = BTreeMap::new();
        for section in ["Unit", "Service", "Install"] {
            let actual = unit.sections.get(section).unwrap_or(&empty);
            let mut exact = Self::section_values(&self.file["exact"], section);
            exact.extend(Self::section_values(&profile_spec["exact"], section));
            let required = Self::section_values(&self.file["required"], section);
            let present = Self::section_keys(&self.file["present"], section);
            for name in exact.keys().chain(required.keys()).chain(present.iter()) {
                guarded.insert(format!("{section}.{name}"));
            }
            let mut allowed: BTreeSet<String> = exact
                .keys()
                .chain(required.keys())
                .chain(present.iter())
                .cloned()
                .collect();
            allowed.extend(Self::section_keys(&self.file["allowed"], section));
            for (name, values) in actual {
                if key_level.contains(&format!("{section}.{name}")) || allowed.contains(name) {
                    apply_forbidden(&mut violations, section, name, values);
                } else {
                    violations.insert(format!("unknown:{section}.{name}"));
                }
            }
            for (name, expected) in &exact {
                let have = actual.get(name).cloned().unwrap_or_default();
                let same = if self.ordered_keys.contains(name) {
                    have == *expected
                } else {
                    have.iter().collect::<BTreeSet<_>>() == expected.iter().collect::<BTreeSet<_>>()
                };
                if !same {
                    violations.insert(format!("exact:{section}.{name}"));
                }
            }
            for (name, expected) in &required {
                let have: BTreeSet<&String> = actual.get(name).into_iter().flatten().collect();
                if !expected.iter().all(|v| have.contains(v)) {
                    violations.insert(format!("required:{section}.{name}"));
                }
            }
            for name in &present {
                if !actual.contains_key(name) {
                    violations.insert(format!("present:{section}.{name}"));
                }
            }
        }
        for reset in &unit.resets {
            if guarded.contains(reset) {
                violations.insert(format!("reset:{reset}"));
            }
        }
        if unit
            .sections
            .keys()
            .any(|s| !matches!(s.as_str(), "Unit" | "Service" | "Install"))
        {
            violations.insert("unknown:Unit.Section".to_owned());
        }

        if profile == "suderra-os" {
            let (Some(board), Some(dropin_text)) = (board, dropin_text) else {
                panic!("suderra-os units need a board drop-in");
            };
            let expected = &profile_spec["board_dropins"]["boards"][board];
            assert!(expected.is_object(), "unknown board {board}");
            let dropin = self.parse(dropin_text);
            for (section, keys) in &dropin.sections {
                for (name, values) in keys {
                    apply_forbidden(&mut violations, section, name, values);
                    let matches = section == "Service"
                        && expected.get(name).is_some_and(|want| {
                            values.iter().collect::<BTreeSet<_>>()
                                == strings(want).iter().collect::<BTreeSet<_>>()
                        });
                    if !matches {
                        violations.insert(format!("dropin:{section}.{name}"));
                    }
                }
            }
            for reset in &dropin.resets {
                violations.insert(format!("reset:{reset}"));
            }
            let dropin_service = dropin.sections.get("Service");
            for name in expected.as_object().expect("board block").keys() {
                if !dropin_service.is_some_and(|s| s.contains_key(name)) {
                    violations.insert(format!("dropin:Service.{name}"));
                }
            }
        } else {
            assert!(
                dropin_text.is_none() && board.is_none(),
                "only suderra-os units take a board drop-in"
            );
        }
        violations
    }
}

fn fixture_text(rel: &str) -> String {
    let path = contract_dir().join("fixtures").join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

#[test]
fn checker_gives_every_golden_unit_its_labelled_violations() {
    let rules = Rules::load();
    let index = read_json(&contract_dir().join("fixtures/index.json"));
    let units = index["units"].as_array().expect("units");
    assert!(units.len() >= 20, "only {} unit fixtures", units.len());
    let mut failures = Vec::new();
    for entry in units {
        let unit = entry["unit"].as_str().expect("unit");
        let dropin = entry["dropin"].as_str().map(fixture_text);
        let got = rules.check(
            entry["profile"].as_str().expect("profile"),
            &fixture_text(unit),
            dropin.as_deref(),
            entry["board_profile"].as_str(),
        );
        let want: BTreeSet<String> = match entry["expect"].as_str() {
            Some("accept") => BTreeSet::new(),
            Some("reject") => strings(&entry["violations"]).into_iter().collect(),
            other => panic!("expect {other:?}"),
        };
        if got != want {
            failures.push(format!(
                "{unit} + {}: want {want:?}, got {got:?}",
                entry["dropin"]
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

fn reference_unit_path() -> PathBuf {
    let rules = Rules::load();
    let declared = rules.file["profiles"]["generic"]["unit_path"]
        .as_str()
        .expect("generic unit_path");
    assert_eq!(rules.file["profiles"]["generic"]["repository"], "aquaculture_platform");
    manifest_dir().join("..").join(declared)
}

#[test]
fn reference_unit_satisfies_the_generic_profile() {
    let path = reference_unit_path();
    assert_eq!(
        path.canonicalize().expect("reference unit exists"),
        manifest_dir()
            .join("systemd/suderra-agent.service")
            .canonicalize()
            .expect("systemd/suderra-agent.service exists"),
        "unit-directives.json names a different generic reference unit"
    );
    let text = std::fs::read_to_string(&path).expect("read reference unit");
    let violations = Rules::load().check("generic", &text, None, None);
    assert!(
        violations.is_empty(),
        "{} violates unit-directives.json: {violations:?}",
        path.display()
    );
}

#[test]
fn reference_unit_grants_no_watchdog_no_tpm_and_no_capability() {
    // The three DEC-1.8 / DEC-6.6 / DEC-21 properties spelled out, so a
    // contract edit that loosened them would still fail here.
    let rules = Rules::load();
    let unit = rules.parse(&std::fs::read_to_string(reference_unit_path()).expect("unit"));
    let service = unit.sections.get("Service").expect("[Service]");
    for device in service.get("DeviceAllow").into_iter().flatten() {
        let node = device.split_ascii_whitespace().next().unwrap_or_default();
        assert!(
            !node.starts_with("/dev/watchdog")
                && !node.starts_with("/dev/tpm")
                && !node.starts_with("char-watchdog")
                && !node.starts_with("char-tpm")
                && !node.starts_with("char-misc"),
            "the agent unit grants {device}"
        );
    }
    assert!(
        !service.contains_key("AmbientCapabilities"),
        "the agent runs with no ambient capability"
    );
    assert_eq!(
        service.get("CapabilityBoundingSet"),
        Some(&Vec::new()),
        "CapabilityBoundingSet= must be the empty bounding set"
    );
    let unit_section = unit.sections.get("Unit").expect("[Unit]");
    assert!(!unit_section.contains_key("Requires"));
    assert!(
        !unit_section
            .get("After")
            .into_iter()
            .flatten()
            .any(|t| t == "network-online.target"),
        "agent start never waits for the network (DEC-6.2)"
    );
}
