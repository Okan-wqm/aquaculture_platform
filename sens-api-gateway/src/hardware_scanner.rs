//! Hardware Scanner — Platform-Aware I/O Channel Auto-Detection
//!
//! Supports three hardware platforms:
//! - **Revolution Pi**: piControl process image via `piTest -d` CLI parsing
//! - **Raspberry Pi**: BCM GPIO enumeration via `/sys/class/gpio/gpiochip*`
//! - **Generic Linux**: Fallback GPIO chip discovery via sysfs
//!
//! # Architecture
//!
//! The scanner is invoked in two contexts:
//! 1. **Boot-time** (`init_hardware` → `publish_capabilities`): Sends a compact
//!    capabilities summary to `tenants/{tid}/devices/{code}/capabilities`.
//! 2. **On-demand** (`scan_hardware` command): Full enumeration requested by
//!    the cloud platform, returning detailed I/O channel list.
//!
//! # Safety
//!
//! All hardware access is read-only (sysfs reads, piTest stdout parsing).
//! No GPIO pins are configured or driven by the scanner.

use serde::{Deserialize, Serialize};
use std::path::Path;
use tracing::{debug, info, warn};

use crate::config::GpioPlatform;

// ============================================================================
// Public Data Types
// ============================================================================

/// Result of a full hardware scan — serialized to JSON for MQTT response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HardwareScanResult {
    /// Detected platform type (e.g. "RevolutionPi", "RaspberryPi")
    pub platform: String,
    /// GPIO chip information (all platforms)
    pub gpio_chips: Vec<GpioChipInfo>,
    /// Revolution Pi specific: piControl I/O modules
    pub picontrol_modules: Vec<PiControlModule>,
    /// Normalized I/O channel list ready for backend import
    pub discovered_ios: Vec<DiscoveredIo>,
    /// ISO 8601 timestamp of scan completion
    pub scan_timestamp: String,
    /// Total number of discovered I/O channels
    pub total_found: usize,
}

/// Information about a single GPIO chip (from sysfs)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpioChipInfo {
    /// Chip identifier (e.g. "gpiochip0")
    pub name: String,
    /// Chip label from driver (e.g. "pinctrl-bcm2835")
    pub label: String,
    /// Base GPIO number
    pub base: u32,
    /// Number of GPIO lines on this chip
    pub ngpio: u32,
}

/// Revolution Pi I/O module discovered via piControl
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PiControlModule {
    /// Module name (e.g. "RevPi DIO", "RevPi AIO")
    pub device_name: String,
    /// Module model identifier
    pub model: String,
    /// Byte offset in process image
    pub offset: u32,
    /// Module data length in bytes
    pub length: u32,
}

/// A single discovered I/O channel — platform-agnostic, ready for import.
///
/// Maps directly to the backend's `AddIoConfigInput` structure.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredIo {
    /// Auto-generated tag name (e.g. "DI_01", "AI_TEMP_1", "GPIO_17")
    pub tag_name: String,
    /// I/O type: "DI" | "DO" | "AI" | "AO"
    pub io_type: String,
    /// Data type: "BOOL" | "INT16" | "INT32" | "UINT16" | "FLOAT32" etc.
    pub data_type: String,
    /// Module address (piControl byte offset or GPIO chip base)
    pub module_address: u32,
    /// Channel/pin number within the module
    pub channel: u32,
    /// Human-readable description
    pub description: String,
    /// GPIO pin number (Raspberry Pi only)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpio_pin: Option<u32>,
    /// Discovery source: "picontrol" | "gpiochip" | "sysfs"
    pub source: String,
}

/// Compact capabilities report sent at boot — lighter than full scan.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HardwareCapabilities {
    /// Detected platform
    pub platform: String,
    /// Whether piControl device is available
    pub has_picontrol: bool,
    /// Number of GPIO chips found
    pub gpio_chip_count: usize,
    /// Total GPIO lines available
    pub total_gpio_lines: u32,
    /// Whether rppal GPIO is available (compiled with `gpio` feature)
    pub rppal_available: bool,
    /// Whether Modbus is configured
    pub modbus_configured: bool,
    /// Scan timestamp
    pub timestamp: String,
}

// ============================================================================
// Hardware Scanner
// ============================================================================

/// Platform-aware hardware scanner.
///
/// Performs read-only enumeration of available I/O channels.
/// Does not configure or drive any pins — purely informational.
pub struct HardwareScanner {
    platform: GpioPlatform,
}

impl HardwareScanner {
    /// Create a new scanner for the given platform.
    pub fn new(platform: GpioPlatform) -> Self {
        Self { platform }
    }

    /// Perform a full hardware scan — returns all discovered I/O channels.
    ///
    /// This is the main entry point for the `scan_hardware` command.
    /// For each platform, it enumerates available hardware and produces
    /// a normalized list of `DiscoveredIo` channels.
    pub fn scan(&self) -> HardwareScanResult {
        info!("Starting hardware scan for platform: {:?}", self.platform);
        let start = std::time::Instant::now();

        let gpio_chips = self.enumerate_gpio_chips();
        let (picontrol_modules, pitest_output) = self.scan_picontrol();
        let mut discovered_ios = Vec::new();

        // Platform-specific I/O discovery
        match self.platform {
            GpioPlatform::RevolutionPi => {
                // Primary: piControl modules (DIO, AIO, etc.)
                discovered_ios.extend(self.discover_picontrol_ios(&picontrol_modules, &pitest_output));
                // Fallback: also report GPIO chips if any
                if discovered_ios.is_empty() {
                    discovered_ios.extend(self.discover_gpio_ios(&gpio_chips));
                }
            }
            GpioPlatform::RaspberryPi => {
                // BCM GPIO enumeration (GPIO 2-27 = usable pins)
                discovered_ios.extend(self.discover_rpi_gpio());
            }
            GpioPlatform::GenericLinux => {
                // Generic GPIO chip enumeration
                discovered_ios.extend(self.discover_gpio_ios(&gpio_chips));
            }
            GpioPlatform::Unknown => {
                // Simulation / unknown — report whatever we find
                discovered_ios.extend(self.discover_gpio_ios(&gpio_chips));
            }
        }

        let total_found = discovered_ios.len();
        let elapsed = start.elapsed();
        info!(
            "Hardware scan complete: {} I/O channels found in {:?}",
            total_found, elapsed
        );

        HardwareScanResult {
            platform: format!("{:?}", self.platform),
            gpio_chips,
            picontrol_modules,
            discovered_ios,
            scan_timestamp: chrono::Utc::now().to_rfc3339(),
            total_found,
        }
    }

    /// Generate a compact capabilities report for boot-time MQTT publish.
    ///
    /// Lighter than a full scan — only reports platform type and availability,
    /// not individual I/O channels.
    pub fn capabilities(&self, modbus_configured: bool) -> HardwareCapabilities {
        let gpio_chips = self.enumerate_gpio_chips();
        let total_lines: u32 = gpio_chips.iter().map(|c| c.ngpio).sum();
        let has_picontrol = Path::new("/dev/piControl0").exists();

        // rppal availability is a compile-time feature gate
        let rppal_available = cfg!(feature = "gpio");

        HardwareCapabilities {
            platform: format!("{:?}", self.platform),
            has_picontrol,
            gpio_chip_count: gpio_chips.len(),
            total_gpio_lines: total_lines,
            rppal_available,
            modbus_configured,
            timestamp: chrono::Utc::now().to_rfc3339(),
        }
    }

    // ========================================================================
    // GPIO Chip Enumeration (all Linux platforms)
    // ========================================================================

    /// Enumerate GPIO chips via `/sys/class/gpio/gpiochip*`.
    ///
    /// Works on all Linux platforms. Returns chip metadata (name, base, ngpio).
    fn enumerate_gpio_chips(&self) -> Vec<GpioChipInfo> {
        let gpio_class = Path::new("/sys/class/gpio");
        if !gpio_class.exists() {
            debug!("No /sys/class/gpio — GPIO enumeration skipped");
            return Vec::new();
        }

        let mut chips = Vec::new();
        let entries = match std::fs::read_dir(gpio_class) {
            Ok(e) => e,
            Err(e) => {
                warn!("Failed to read /sys/class/gpio: {}", e);
                return Vec::new();
            }
        };

        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with("gpiochip") {
                continue;
            }

            let chip_path = entry.path();
            let base = read_sysfs_u32(&chip_path.join("base")).unwrap_or(0);
            let ngpio = read_sysfs_u32(&chip_path.join("ngpio")).unwrap_or(0);
            let label = read_sysfs_string(&chip_path.join("label"))
                .unwrap_or_else(|| "unknown".to_string());

            chips.push(GpioChipInfo {
                name,
                label,
                base,
                ngpio,
            });
        }

        chips.sort_by_key(|c| c.base);
        debug!("Found {} GPIO chips", chips.len());
        chips
    }

    // ========================================================================
    // Revolution Pi — piControl Scanning
    // ========================================================================

    /// Scan Revolution Pi I/O modules via `piTest -d`.
    ///
    /// The `piTest` utility lists all modules in the piControl process image.
    /// If `piTest` is not available, falls back to checking `/dev/piControl0`.
    /// Run `piTest -d` once and return (modules, raw_output).
    /// The raw output is reused by `discover_picontrol_ios` to avoid a second invocation.
    fn scan_picontrol(&self) -> (Vec<PiControlModule>, String) {
        if self.platform != GpioPlatform::RevolutionPi {
            return (Vec::new(), String::new());
        }

        if !Path::new("/dev/piControl0").exists() {
            debug!("No /dev/piControl0 — piControl scanning skipped");
            return (Vec::new(), String::new());
        }

        // Run piTest -d once for both module and pin enumeration.
        // Use absolute path to prevent PATH injection (MQTT-triggered command).
        match std::process::Command::new("/usr/bin/piTest").arg("-d").output() {
            Ok(output) => {
                if output.status.success() {
                    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                    let modules = self.parse_pitest_output(&stdout);
                    (modules, stdout)
                } else {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    warn!("piTest -d failed: {}", stderr);
                    (Vec::new(), String::new())
                }
            }
            Err(e) => {
                warn!("piTest not found or failed to execute: {}", e);
                // Fallback: at least report that piControl exists
                (vec![PiControlModule {
                    device_name: "piControl0".to_string(),
                    model: "unknown".to_string(),
                    offset: 0,
                    length: 0,
                }], String::new())
            }
        }
    }

    /// Parse `piTest -d` stdout into structured module list.
    ///
    /// Expected format:
    /// ```text
    /// device_name:    RevPi Connect 4
    ///   model:         7d.00 (Rev 01)
    ///   offset:        0
    ///   length:        484
    ///
    /// device_name:    RevPi DIO
    ///   model:         97.00 (Rev 00)
    ///   offset:        484
    ///   length:        70
    ///   I_1             Inp   bit      484.0
    ///   I_2             Inp   bit      484.1
    ///   O_1             Out   bit      488.0
    /// ```
    fn parse_pitest_output(&self, output: &str) -> Vec<PiControlModule> {
        let mut modules = Vec::new();
        let mut current: Option<PiControlModule> = None;

        for line in output.lines() {
            let trimmed = line.trim();

            if trimmed.starts_with("device_name:") {
                // Save previous module if any
                if let Some(m) = current.take() {
                    modules.push(m);
                }
                let name = trimmed
                    .trim_start_matches("device_name:")
                    .trim()
                    .to_string();
                current = Some(PiControlModule {
                    device_name: name,
                    model: String::new(),
                    offset: 0,
                    length: 0,
                });
            } else if let Some(ref mut m) = current {
                if trimmed.starts_with("model:") {
                    m.model = trimmed.trim_start_matches("model:").trim().to_string();
                } else if trimmed.starts_with("offset:") {
                    m.offset = trimmed
                        .trim_start_matches("offset:")
                        .trim()
                        .parse()
                        .unwrap_or(0);
                } else if trimmed.starts_with("length:") {
                    m.length = trimmed
                        .trim_start_matches("length:")
                        .trim()
                        .parse()
                        .unwrap_or(0);
                }
            }
        }

        // Don't forget the last module
        if let Some(m) = current {
            modules.push(m);
        }

        info!("piTest parsed {} modules", modules.len());
        modules
    }

    /// Discover I/O channels from piControl modules.
    ///
    /// Uses the cached `piTest -d` output to find individual I/O pins (Inp/Out lines).
    /// If detailed pin info isn't available, generates standard DIO/AIO channels
    /// based on known module types.
    fn discover_picontrol_ios(&self, modules: &[PiControlModule], pitest_output: &str) -> Vec<DiscoveredIo> {
        let mut ios = Vec::new();

        // Reuse the piTest -d output captured in scan_picontrol()
        if !pitest_output.is_empty() {
            ios.extend(self.parse_pitest_pins(pitest_output, modules));
        }

        // If no pins found via piTest, generate based on known module types
        if ios.is_empty() {
            for module in modules {
                ios.extend(self.generate_default_module_ios(module));
            }
        }

        ios
    }

    /// Parse individual I/O pin lines from piTest -d output.
    ///
    /// Pin lines appear after module header and look like:
    /// `  I_1             Inp   bit      484.0`
    /// `  O_1             Out   bit      488.0`
    /// `  InputValue_1    Inp   word     490`
    fn parse_pitest_pins(
        &self,
        output: &str,
        modules: &[PiControlModule],
    ) -> Vec<DiscoveredIo> {
        let mut ios = Vec::new();
        let mut current_module: Option<&PiControlModule> = None;
        let mut di_count: u32 = 0;
        let mut do_count: u32 = 0;
        let mut ai_count: u32 = 0;
        let mut ao_count: u32 = 0;

        for line in output.lines() {
            let trimmed = line.trim();

            // Module header — match to our parsed modules
            if trimmed.starts_with("device_name:") {
                let name = trimmed.trim_start_matches("device_name:").trim();
                current_module = modules.iter().find(|m| m.device_name == name);
                continue;
            }

            // Skip non-pin lines (model, offset, length, empty)
            if trimmed.is_empty()
                || trimmed.starts_with("model:")
                || trimmed.starts_with("offset:")
                || trimmed.starts_with("length:")
            {
                continue;
            }

            // Try to parse pin line: NAME  Inp/Out  bit/word/dword  OFFSET.BIT
            let parts: Vec<&str> = trimmed.split_whitespace().collect();
            if parts.len() < 3 {
                continue;
            }

            let pin_name = parts[0];
            let direction = parts[1]; // "Inp" or "Out"
            let size = parts[2]; // "bit", "word", "dword"

            // Parse offset.bit (e.g. "484.0" or "490")
            let offset_str = match parts.get(3) {
                Some(s) => s,
                None => {
                    warn!("piTest pin line missing offset: '{}'", trimmed);
                    continue;
                }
            };
            let (byte_offset, bit_pos) = if let Some(dot_pos) = offset_str.find('.') {
                match (offset_str[..dot_pos].parse::<u32>(), offset_str[dot_pos + 1..].parse::<u32>()) {
                    (Ok(byte_off), Ok(bit)) => (byte_off, bit),
                    _ => {
                        warn!("piTest pin line malformed offset '{}': '{}'", offset_str, trimmed);
                        continue;
                    }
                }
            } else {
                match offset_str.parse::<u32>() {
                    Ok(byte_off) => (byte_off, 0),
                    Err(_) => {
                        warn!("piTest pin line malformed offset '{}': '{}'", offset_str, trimmed);
                        continue;
                    }
                }
            };

            // Determine I/O type and data type
            let (io_type, data_type) = match (direction, size) {
                ("Inp", "bit") => {
                    di_count += 1;
                    ("DI", "BOOL")
                }
                ("Out", "bit") => {
                    do_count += 1;
                    ("DO", "BOOL")
                }
                ("Inp", "word") => {
                    ai_count += 1;
                    ("AI", "INT16")
                }
                ("Out", "word") => {
                    ao_count += 1;
                    ("AO", "INT16")
                }
                ("Inp", "dword") => {
                    ai_count += 1;
                    ("AI", "INT32")
                }
                ("Out", "dword") => {
                    ao_count += 1;
                    ("AO", "INT32")
                }
                _ => continue, // Unknown direction/size
            };

            let module_name = current_module
                .map(|m| m.device_name.as_str())
                .unwrap_or("Unknown");

            ios.push(DiscoveredIo {
                tag_name: pin_name.to_string(),
                io_type: io_type.to_string(),
                data_type: data_type.to_string(),
                module_address: byte_offset,
                channel: bit_pos,
                description: format!("{}, {} ({})", module_name, pin_name, size),
                gpio_pin: None,
                source: "picontrol".to_string(),
            });
        }

        info!(
            "piControl pins: {} DI, {} DO, {} AI, {} AO",
            di_count, do_count, ai_count, ao_count
        );
        ios
    }

    /// Generate default I/O channels for known Revolution Pi module types.
    ///
    /// Used as fallback when `piTest -d` doesn't provide individual pin info.
    /// Based on standard RevPi DIO (14 DI + 14 DO) and AIO (4 AI + 2 AO).
    fn generate_default_module_ios(&self, module: &PiControlModule) -> Vec<DiscoveredIo> {
        let mut ios = Vec::new();
        let name_lower = module.device_name.to_lowercase();

        if name_lower.contains("dio") {
            // Standard RevPi DIO: 14 digital inputs + 14 digital outputs
            for i in 1..=14 {
                ios.push(DiscoveredIo {
                    tag_name: format!("I_{}", i),
                    io_type: "DI".to_string(),
                    data_type: "BOOL".to_string(),
                    module_address: module.offset,
                    channel: i,
                    description: format!("{}, Digital Input {}", module.device_name, i),
                    gpio_pin: None,
                    source: "picontrol".to_string(),
                });
            }
            for i in 1..=14 {
                ios.push(DiscoveredIo {
                    tag_name: format!("O_{}", i),
                    io_type: "DO".to_string(),
                    data_type: "BOOL".to_string(),
                    module_address: module.offset,
                    channel: i,
                    description: format!("{}, Digital Output {}", module.device_name, i),
                    gpio_pin: None,
                    source: "picontrol".to_string(),
                });
            }
        } else if name_lower.contains("aio") {
            // Standard RevPi AIO: 4 analog inputs + 2 analog outputs
            for i in 1..=4 {
                ios.push(DiscoveredIo {
                    tag_name: format!("InputValue_{}", i),
                    io_type: "AI".to_string(),
                    data_type: "INT16".to_string(),
                    module_address: module.offset,
                    channel: i,
                    description: format!("{}, Analog Input {}", module.device_name, i),
                    gpio_pin: None,
                    source: "picontrol".to_string(),
                });
            }
            for i in 1..=2 {
                ios.push(DiscoveredIo {
                    tag_name: format!("OutputValue_{}", i),
                    io_type: "AO".to_string(),
                    data_type: "INT16".to_string(),
                    module_address: module.offset,
                    channel: i,
                    description: format!("{}, Analog Output {}", module.device_name, i),
                    gpio_pin: None,
                    source: "picontrol".to_string(),
                });
            }
        }
        // Skip Connect/Compact/Gateway modules — they are compute modules, not I/O

        ios
    }

    // ========================================================================
    // Raspberry Pi — BCM GPIO Enumeration
    // ========================================================================

    /// Discover Raspberry Pi GPIO pins (BCM 2-27).
    ///
    /// The 26 usable BCM pins are reported as available I/O channels.
    /// Pin direction is unknown at scan time — all are reported as "DI"
    /// (user can change direction after import).
    fn discover_rpi_gpio(&self) -> Vec<DiscoveredIo> {
        // BCM GPIO pins 2-27 are user-accessible on all RPi models
        // GPIO 0-1 are reserved for I2C (HAT EEPROM)
        const BCM_USABLE_PINS: [u32; 26] = [
            2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
            25, 26, 27,
        ];

        let mut ios = Vec::new();
        for &pin in &BCM_USABLE_PINS {
            ios.push(DiscoveredIo {
                tag_name: format!("GPIO_{:02}", pin),
                io_type: "DI".to_string(), // Default — user selects direction post-import
                data_type: "BOOL".to_string(),
                module_address: 0, // BCM has single "module"
                channel: pin,
                description: format!("Raspberry Pi BCM GPIO {}", pin),
                gpio_pin: Some(pin),
                source: "gpiochip".to_string(),
            });
        }

        info!("RPi GPIO: {} usable pins enumerated", ios.len());
        ios
    }

    // ========================================================================
    // Generic Linux — GPIO Chip I/O Discovery
    // ========================================================================

    /// Discover I/O channels from generic GPIO chips.
    ///
    /// Reports each GPIO line as a potential I/O channel.
    /// Limited to first 64 lines per chip to prevent excessive results.
    fn discover_gpio_ios(&self, chips: &[GpioChipInfo]) -> Vec<DiscoveredIo> {
        let mut ios = Vec::new();
        const MAX_LINES_PER_CHIP: u32 = 64;

        for chip in chips {
            let line_count = chip.ngpio.min(MAX_LINES_PER_CHIP);
            for line in 0..line_count {
                ios.push(DiscoveredIo {
                    tag_name: format!("{}_{}", chip.name, line),
                    io_type: "DI".to_string(),
                    data_type: "BOOL".to_string(),
                    module_address: chip.base,
                    channel: line,
                    description: format!("{} line {} ({})", chip.name, line, chip.label),
                    gpio_pin: Some(chip.base + line),
                    source: "sysfs".to_string(),
                });
            }
        }

        ios
    }
}

// ============================================================================
// sysfs Helper Functions
// ============================================================================

/// Read a u32 value from a sysfs file.
fn read_sysfs_u32(path: &Path) -> Option<u32> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| s.trim().parse().ok())
}

/// Read a string value from a sysfs file (trimmed).
fn read_sysfs_string(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pitest_output_parsing() {
        let scanner = HardwareScanner::new(GpioPlatform::RevolutionPi);
        let output = r#"
device_name:    RevPi Connect 4
  model:         7d.00 (Rev 01)
  offset:        0
  length:        484

device_name:    RevPi DIO
  model:         97.00 (Rev 00)
  offset:        484
  length:        70
"#;

        let modules = scanner.parse_pitest_output(output);
        assert_eq!(modules.len(), 2);
        assert_eq!(modules[0].device_name, "RevPi Connect 4");
        assert_eq!(modules[0].offset, 0);
        assert_eq!(modules[0].length, 484);
        assert_eq!(modules[1].device_name, "RevPi DIO");
        assert_eq!(modules[1].offset, 484);
    }

    #[test]
    fn test_rpi_gpio_discovery() {
        let scanner = HardwareScanner::new(GpioPlatform::RaspberryPi);
        let ios = scanner.discover_rpi_gpio();
        assert_eq!(ios.len(), 26);
        assert_eq!(ios[0].tag_name, "GPIO_02");
        assert_eq!(ios[0].gpio_pin, Some(2));
        assert_eq!(ios[25].tag_name, "GPIO_27");
    }

    #[test]
    fn test_default_dio_module_generation() {
        let scanner = HardwareScanner::new(GpioPlatform::RevolutionPi);
        let module = PiControlModule {
            device_name: "RevPi DIO".to_string(),
            model: "97.00".to_string(),
            offset: 484,
            length: 70,
        };

        let ios = scanner.generate_default_module_ios(&module);
        // 14 DI + 14 DO = 28 channels
        assert_eq!(ios.len(), 28);
        assert_eq!(ios[0].io_type, "DI");
        assert_eq!(ios[0].tag_name, "I_1");
        assert_eq!(ios[14].io_type, "DO");
        assert_eq!(ios[14].tag_name, "O_1");
    }

    #[test]
    fn test_default_aio_module_generation() {
        let scanner = HardwareScanner::new(GpioPlatform::RevolutionPi);
        let module = PiControlModule {
            device_name: "RevPi AIO".to_string(),
            model: "69.00".to_string(),
            offset: 554,
            length: 24,
        };

        let ios = scanner.generate_default_module_ios(&module);
        // 4 AI + 2 AO = 6 channels
        assert_eq!(ios.len(), 6);
        assert_eq!(ios[0].io_type, "AI");
        assert_eq!(ios[4].io_type, "AO");
    }

    #[test]
    fn test_pitest_pin_parsing() {
        let scanner = HardwareScanner::new(GpioPlatform::RevolutionPi);
        let modules = vec![PiControlModule {
            device_name: "RevPi DIO".to_string(),
            model: "97.00".to_string(),
            offset: 484,
            length: 70,
        }];

        let output = r#"
device_name:    RevPi DIO
  model:         97.00 (Rev 00)
  offset:        484
  length:        70
  I_1             Inp   bit      484.0
  I_2             Inp   bit      484.1
  O_1             Out   bit      488.0
  InputValue_1    Inp   word     490
"#;

        let ios = scanner.parse_pitest_pins(output, &modules);
        assert_eq!(ios.len(), 4);
        assert_eq!(ios[0].tag_name, "I_1");
        assert_eq!(ios[0].io_type, "DI");
        assert_eq!(ios[0].data_type, "BOOL");
        assert_eq!(ios[2].tag_name, "O_1");
        assert_eq!(ios[2].io_type, "DO");
        assert_eq!(ios[3].tag_name, "InputValue_1");
        assert_eq!(ios[3].io_type, "AI");
        assert_eq!(ios[3].data_type, "INT16");
    }
}
