//! Hardware Scanner — Platform-Aware I/O Channel Auto-Detection
//!
//! Supports three hardware platforms:
//! - **Revolution Pi**: the piControl device list (`KB_GET_DEVICE_INFO_LIST`) and
//!   the PiCtory `config.rsc` it loaded; no helper process is executed
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
//! All hardware access is read-only (sysfs reads, a read-only piControl
//! descriptor).
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
    /// I2C buses and discovered devices
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub i2c_buses: Vec<I2cBusScanInfo>,
    /// SPI bus/chip-select pairs
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub spi_buses: Vec<SpiBusInfo>,
    /// UART serial ports
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub uart_ports: Vec<UartPortInfo>,
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
    /// Discovery source: "picontrol" | "gpiochip" | "sysfs" | "i2c" | "spi" | "uart"
    pub source: String,
    /// Bus type: "i2c" | "spi" | "uart" (None for GPIO-based channels)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bus_type: Option<String>,
    /// I2C bus number (0-7)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub i2c_bus: Option<u8>,
    /// I2C device address (0x03..0x77)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub i2c_address: Option<u8>,
    /// Known I2C device name (e.g. "BME280", "ADS1115")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub i2c_device_name: Option<String>,
    /// SPI bus number
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spi_bus: Option<u8>,
    /// SPI chip select number
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spi_cs: Option<u8>,
    /// UART port device path
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uart_port: Option<String>,
}

/// The unsigned data type of an analog channel of this width: PiCtory does not
/// record a variable's signedness, so the scan reports the unsigned reading.
#[cfg(any(target_os = "linux", test))]
fn unsigned_name(width: crate::picontrol::rsc::Width) -> &'static str {
    use crate::picontrol::rsc::Width;
    match width {
        Width::Bit => "BOOL",
        Width::Byte => "UINT8",
        Width::Word => "UINT16",
        Width::DWord => "UINT32",
    }
}

/// Information about a single I2C device discovered on a bus.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct I2cDeviceInfo {
    pub address: u8,
    pub address_hex: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_description: Option<String>,
}

/// Result of scanning a single I2C bus.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct I2cBusScanInfo {
    pub bus: u8,
    pub device_count: usize,
    pub devices: Vec<I2cDeviceInfo>,
}

/// SPI bus/chip-select pair discovered via /dev/spidevX.Y.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpiBusInfo {
    pub device_path: String,
    pub bus: u8,
    pub chip_select: u8,
}

/// UART port discovered via /dev/tty*.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UartPortInfo {
    pub device_path: String,
    pub port_type: String,
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
    /// Number of I2C buses found
    pub i2c_bus_count: usize,
    /// Number of SPI buses found
    pub spi_bus_count: usize,
    /// Number of UART ports found
    pub uart_port_count: usize,
    /// Whether LoRaWAN concentrator is available (v1.5.0)
    pub has_lorawan: bool,
    /// Scan timestamp
    pub timestamp: String,
}

// ============================================================================
// Hardware Scanner
// ============================================================================

/// Identify a known I2C device by its bus address.
/// Returns (device_name, description, io_type, data_type) if recognized.
fn identify_i2c_device(
    address: u8,
) -> Option<(&'static str, &'static str, &'static str, &'static str)> {
    match address {
        0x76 | 0x77 => Some((
            "BME280",
            "Temperature/Humidity/Pressure sensor",
            "AI",
            "FLOAT32",
        )),
        0x44 | 0x45 => Some(("SHT31", "Temperature/Humidity sensor", "AI", "FLOAT32")),
        0x48..=0x4B => Some(("ADS1115", "16-bit 4-channel ADC", "AI", "INT16")),
        0x61 => Some((
            "ATLAS_DO",
            "Atlas Scientific Dissolved Oxygen",
            "AI",
            "FLOAT32",
        )),
        0x62 => Some(("ATLAS_ORP", "Atlas Scientific ORP sensor", "AI", "FLOAT32")),
        0x63 => Some(("ATLAS_PH", "Atlas Scientific pH sensor", "AI", "FLOAT32")),
        0x64 => Some(("ATLAS_EC", "Atlas Scientific Conductivity", "AI", "FLOAT32")),
        0x66 => Some((
            "ATLAS_RTD",
            "Atlas Scientific RTD Temperature",
            "AI",
            "FLOAT32",
        )),
        0x10 => Some(("VEML7700", "Ambient Light sensor", "AI", "FLOAT32")),
        0x23 => Some(("BH1750", "Digital Light sensor", "AI", "FLOAT32")),
        0x20..=0x22 | 0x24..=0x27 => Some(("PCF8574", "8-bit I/O Expander", "DI", "BOOL")),
        0x60 => Some(("MCP4725", "12-bit DAC", "AO", "UINT16")),
        0x68 => Some(("DS3231", "RTC / MPU6050 IMU", "AI", "INT32")),
        _ => None,
    }
}

/// Platform-aware hardware scanner.
///
/// Performs read-only enumeration of available I/O channels.
/// Does not configure or drive any pins — purely informational.
pub struct HardwareScanner {
    platform: GpioPlatform,
    /// Where the PiCtory `config.rsc` the driver loaded can be read from, for
    /// the channel list of a Revolution Pi.
    rsc: Option<crate::picontrol::RscSource>,
}

impl HardwareScanner {
    /// Create a new scanner for the given platform.
    pub fn new(platform: GpioPlatform) -> Self {
        Self {
            platform,
            rsc: None,
        }
    }

    /// Name the `config.rsc` a Revolution Pi scan reads its channels from.
    pub fn with_rsc(mut self, rsc: Option<crate::picontrol::RscSource>) -> Self {
        self.rsc = rsc;
        self
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
        let (picontrol_modules, picontrol_ios) = self.scan_picontrol();
        let mut discovered_ios = Vec::new();

        // Platform-specific I/O discovery
        match self.platform {
            GpioPlatform::RevolutionPi => {
                // Primary: piControl modules (DIO, AIO, etc.)
                discovered_ios.extend(picontrol_ios);
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

        // I2C bus scanning
        let i2c_buses = self.scan_i2c_buses();
        for bus in &i2c_buses {
            discovered_ios.extend(self.i2c_bus_to_discovered_ios(bus));
        }

        // SPI bus enumeration
        let spi_buses = self.enumerate_spi_buses();
        for spi in &spi_buses {
            discovered_ios.extend(self.spi_to_discovered_ios(spi));
        }

        // UART port enumeration
        let uart_ports = self.enumerate_uart_ports();
        for uart in &uart_ports {
            discovered_ios.extend(self.uart_to_discovered_ios(uart));
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
            i2c_buses,
            spi_buses,
            uart_ports,
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
        let has_picontrol = Path::new(crate::picontrol::DEVICE_PATH).exists();

        // rppal availability is a compile-time feature gate
        let rppal_available = cfg!(feature = "gpio");

        // Count I2C buses
        let i2c_bus_count = (0u8..=7)
            .filter(|bus| Path::new(&format!("/dev/i2c-{}", bus)).exists())
            .count();

        // Count SPI buses
        let spi_bus_count = std::fs::read_dir("/dev")
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|e| e.file_name().to_string_lossy().starts_with("spidev"))
                    .count()
            })
            .unwrap_or(0);

        // Count UART ports
        let uart_port_count = std::fs::read_dir("/dev")
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|e| {
                        let name = e.file_name().to_string_lossy().to_string();
                        name.starts_with("ttyAMA")
                            || name.starts_with("ttyS")
                            || name.starts_with("ttyUSB")
                            || name.starts_with("ttyACM")
                    })
                    .count()
            })
            .unwrap_or(0);

        // LoRaWAN: SX1302 concentrator is available when lorawan feature is compiled
        let has_lorawan = cfg!(feature = "lorawan");

        HardwareCapabilities {
            platform: format!("{:?}", self.platform),
            has_picontrol,
            gpio_chip_count: gpio_chips.len(),
            total_gpio_lines: total_lines,
            rppal_available,
            modbus_configured,
            i2c_bus_count,
            spi_bus_count,
            uart_port_count,
            has_lorawan,
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

    /// Scan the Revolution Pi modules through `/dev/piControl0` itself
    /// (ADR-048 DEC-8.8): the device list comes from `KB_GET_DEVICE_INFO_LIST`,
    /// the variables from the PiCtory `config.rsc` the driver loaded. No process
    /// is executed: `piTest` is not part of the Suderra OS image, and an MQTT
    /// triggered scan must not fork a helper.
    ///
    /// The descriptor is opened read-only; the scan writes nothing and arms
    /// nothing. A device that is absent or cannot be opened is no modules.
    fn scan_picontrol(&self) -> (Vec<PiControlModule>, Vec<DiscoveredIo>) {
        if self.platform != GpioPlatform::RevolutionPi {
            return (Vec::new(), Vec::new());
        }
        #[cfg(target_os = "linux")]
        {
            use crate::picontrol::device::{LibcDevice, PiControl};
            let device = match LibcDevice::open_read_only(Path::new(crate::picontrol::DEVICE_PATH))
            {
                Ok(device) => device,
                Err(e) => {
                    debug!(
                        "{} not usable — piControl scanning skipped: {}",
                        crate::picontrol::DEVICE_PATH,
                        e
                    );
                    return (Vec::new(), Vec::new());
                }
            };
            let pi = PiControl::new(std::sync::Arc::new(device));
            let map = self.rsc.as_ref().and_then(|source| {
                let bytes = source
                    .load()
                    .map_err(|e| warn!("config.rsc could not be read for the scan: {}", e))
                    .ok()?;
                crate::picontrol::rsc::ProcessMap::parse(&bytes)
                    .map_err(|e| warn!("config.rsc is not usable for the scan: {}", e))
                    .ok()
            });
            self.discover_picontrol(&pi, map.as_ref())
        }
        #[cfg(not(target_os = "linux"))]
        {
            (Vec::new(), Vec::new())
        }
    }

    /// The modules the driver lists and, from `config.rsc`, the channels the
    /// agent could read or write on them: inputs of every active module,
    /// outputs of the I/O expansion modules only (the grant the backend gives,
    /// `picontrol::registry`). Memory and module-configuration variables are
    /// not channels.
    #[cfg(any(target_os = "linux", test))]
    fn discover_picontrol(
        &self,
        pi: &crate::picontrol::device::PiControl,
        map: Option<&crate::picontrol::rsc::ProcessMap>,
    ) -> (Vec<PiControlModule>, Vec<DiscoveredIo>) {
        use crate::picontrol::abi::module_type;
        use crate::picontrol::rsc::{Section, Width};

        let listed = match pi.devices() {
            Ok(listed) => listed,
            Err(e) => {
                warn!("piControl device list could not be read: {}", e);
                return (Vec::new(), Vec::new());
            }
        };
        // A module configured but not connected has no data and no outputs.
        let active: Vec<_> = listed
            .iter()
            .filter(|m| m.active && m.module_type & crate::picontrol::abi::NOT_CONNECTED == 0)
            .collect();
        let modules: Vec<PiControlModule> = active
            .iter()
            .map(|m| PiControlModule {
                device_name: module_type::name(m.product_type()).to_string(),
                model: format!("KUNBUS module type {}", m.product_type()),
                offset: u32::from(m.base_offset),
                length: u32::from(m.input_length)
                    + u32::from(m.output_length)
                    + u32::from(m.config_length),
            })
            .collect();

        let mut ios = Vec::new();
        let (mut di, mut do_, mut ai, mut ao) = (0u32, 0u32, 0u32, 0u32);
        if let Some(map) = map {
            for var in map.variables() {
                let Some(module) = active.iter().find(|m| m.address == var.device) else {
                    continue;
                };
                let Some(width) = var.width() else {
                    continue;
                };
                let output = match var.section {
                    Section::Input => false,
                    Section::Output
                        if module_type::is_io_expansion(module.product_type()) && !var.exported =>
                    {
                        true
                    }
                    _ => continue,
                };
                let (io_type, data_type) = match (width, output) {
                    (Width::Bit, false) => {
                        di += 1;
                        ("DI", "BOOL")
                    }
                    (Width::Bit, true) => {
                        do_ += 1;
                        ("DO", "BOOL")
                    }
                    (w, false) => {
                        ai += 1;
                        ("AI", unsigned_name(w))
                    }
                    (w, true) => {
                        ao += 1;
                        ("AO", unsigned_name(w))
                    }
                };
                ios.push(DiscoveredIo {
                    tag_name: var.name.to_string(),
                    io_type: io_type.to_string(),
                    data_type: data_type.to_string(),
                    module_address: u32::from(var.address),
                    channel: u32::from(var.bit),
                    description: format!(
                        "{}, {} ({} bit)",
                        module_type::name(module.product_type()),
                        var.name,
                        var.bit_length
                    ),
                    gpio_pin: None,
                    source: "picontrol".to_string(),
                    bus_type: None,
                    i2c_bus: None,
                    i2c_address: None,
                    i2c_device_name: None,
                    spi_bus: None,
                    spi_cs: None,
                    uart_port: None,
                });
            }
        }
        info!(
            "piControl: {} modules, {} DI, {} DO, {} AI, {} AO",
            modules.len(),
            di,
            do_,
            ai,
            ao
        );
        (modules, ios)
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
            2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
            26, 27,
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
                bus_type: None,
                i2c_bus: None,
                i2c_address: None,
                i2c_device_name: None,
                spi_bus: None,
                spi_cs: None,
                uart_port: None,
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
                    bus_type: None,
                    i2c_bus: None,
                    i2c_address: None,
                    i2c_device_name: None,
                    spi_bus: None,
                    spi_cs: None,
                    uart_port: None,
                });
            }
        }

        ios
    }

    // ========================================================================
    // I2C Bus Scanning
    // ========================================================================

    /// Scan I2C buses (0-7) for connected devices.
    ///
    /// Uses rppal I2C (with `gpio` feature) or i2cdetect command (fallback)
    /// to probe addresses 0x03..=0x77 on each available bus.
    fn scan_i2c_buses(&self) -> Vec<I2cBusScanInfo> {
        let mut results = Vec::new();

        // Scan buses 0-7 to cover SBCs with multiple I2C controllers / muxes
        for bus_num in 0u8..=7 {
            let dev_path = format!("/dev/i2c-{}", bus_num);
            if !Path::new(&dev_path).exists() {
                continue;
            }

            let devices = self.probe_i2c_bus(bus_num);
            let device_count = devices.len();
            if device_count > 0 {
                info!("I2C bus {}: {} devices found", bus_num, device_count);
            } else {
                debug!("I2C bus {}: no devices found", bus_num);
            }

            results.push(I2cBusScanInfo {
                bus: bus_num,
                device_count,
                devices,
            });
        }

        results
    }

    /// Probe a single I2C bus for responsive addresses.
    #[cfg(feature = "gpio")]
    fn probe_i2c_bus(&self, bus: u8) -> Vec<I2cDeviceInfo> {
        let mut devices = Vec::new();

        let mut i2c = match rppal::i2c::I2c::with_bus(bus) {
            Ok(i2c) => i2c,
            Err(e) => {
                warn!("Failed to open I2C bus {}: {}", bus, e);
                return devices;
            }
        };

        for addr in 0x03u8..=0x77 {
            if i2c.set_slave_address(addr as u16).is_err() {
                continue;
            }

            // Probe with a zero-byte read
            let mut buf = [0u8; 1];
            if i2c.read(&mut buf).is_ok() {
                let known = identify_i2c_device(addr);
                devices.push(I2cDeviceInfo {
                    address: addr,
                    address_hex: format!("0x{:02X}", addr),
                    device_name: known.map(|(name, _, _, _)| name.to_string()),
                    device_description: known.map(|(_, desc, _, _)| desc.to_string()),
                });
            }
        }

        devices
    }

    /// Fallback for non-gpio builds: use i2cdetect command to probe I2C bus.
    /// Uses an absolute path to prevent PATH injection.
    #[cfg(not(feature = "gpio"))]
    fn probe_i2c_bus(&self, bus: u8) -> Vec<I2cDeviceInfo> {
        use std::process::Command;

        // Try absolute path first, fall back to PATH lookup
        let i2cdetect = if Path::new("/usr/sbin/i2cdetect").exists() {
            "/usr/sbin/i2cdetect"
        } else if Path::new("/usr/bin/i2cdetect").exists() {
            "/usr/bin/i2cdetect"
        } else {
            "i2cdetect"
        };

        let output = match Command::new(i2cdetect)
            .args(["-y", &bus.to_string()])
            .output()
        {
            Ok(o) => o,
            Err(e) => {
                warn!("i2cdetect not available for bus {}: {}", bus, e);
                return Vec::new();
            }
        };

        if !output.status.success() {
            warn!(
                "i2cdetect failed for bus {}: {}",
                bus,
                String::from_utf8_lossy(&output.stderr)
            );
            return Vec::new();
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        Self::parse_i2cdetect_output(&stdout)
    }

    /// Parse i2cdetect -y output into I2cDeviceInfo list.
    ///
    /// Output format:
    /// ```text
    ///      0  1  2  3  4  5  6  7  8  9  a  b  c  d  e  f
    /// 00:          -- -- -- -- -- -- -- -- -- -- -- -- --
    /// 10: -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
    /// 20: -- -- -- -- -- -- -- 27 -- -- -- -- -- -- -- --
    /// 70: -- -- -- -- -- -- 76 --
    /// ```
    ///
    /// The 00: row starts at column 3 (addresses 0x03-0x0f), all other rows
    /// have 16 columns (0x0-0xf offset from row base).
    fn parse_i2cdetect_output(stdout: &str) -> Vec<I2cDeviceInfo> {
        let mut devices = Vec::new();

        for line in stdout.lines() {
            let line = line.trim();
            let Some(colon_pos) = line.find(':') else {
                continue;
            };
            let row_prefix = &line[..colon_pos];
            let Ok(row_base) = u8::from_str_radix(row_prefix.trim(), 16) else {
                continue;
            };

            // Parse each token after the colon.
            // i2cdetect tokens are hex addresses ("27", "76") or placeholders ("--", "UU").
            // We use the token value itself as the address (not column position)
            // because the 00: row has a variable number of columns.
            for token in line[colon_pos + 1..].split_whitespace() {
                if token == "--" || token == "UU" {
                    continue;
                }
                if let Ok(addr) = u8::from_str_radix(token, 16) {
                    // Sanity check: address should be in the same row
                    if addr >= row_base
                        && addr < row_base.saturating_add(16)
                        && addr >= 0x03
                        && addr <= 0x77
                    {
                        let known = identify_i2c_device(addr);
                        devices.push(I2cDeviceInfo {
                            address: addr,
                            address_hex: format!("0x{:02X}", addr),
                            device_name: known.map(|(name, _, _, _)| name.to_string()),
                            device_description: known.map(|(_, desc, _, _)| desc.to_string()),
                        });
                    }
                }
            }
        }

        if !devices.is_empty() {
            info!("i2cdetect found {} devices", devices.len());
        }
        devices
    }

    /// Convert an I2C bus scan result into DiscoveredIo entries.
    fn i2c_bus_to_discovered_ios(&self, bus_info: &I2cBusScanInfo) -> Vec<DiscoveredIo> {
        let mut ios = Vec::new();

        for device in &bus_info.devices {
            let known = identify_i2c_device(device.address);
            let (tag_name, io_type, data_type, description) = match known {
                Some((name, desc, io, dt)) => (
                    format!("{}_B{}_{}", name, bus_info.bus, device.address_hex),
                    io.to_string(),
                    dt.to_string(),
                    format!("I2C-{} @ {}: {}", bus_info.bus, device.address_hex, desc),
                ),
                None => (
                    format!("I2C_B{}_{}", bus_info.bus, device.address_hex),
                    "AI".to_string(),
                    "FLOAT32".to_string(),
                    format!(
                        "Unknown I2C device @ bus {} addr {}",
                        bus_info.bus, device.address_hex
                    ),
                ),
            };

            ios.push(DiscoveredIo {
                tag_name,
                io_type,
                data_type,
                module_address: bus_info.bus as u32,
                channel: device.address as u32,
                description,
                gpio_pin: None,
                source: "i2c".to_string(),
                bus_type: Some("i2c".to_string()),
                i2c_bus: Some(bus_info.bus),
                i2c_address: Some(device.address),
                i2c_device_name: device.device_name.clone(),
                spi_bus: None,
                spi_cs: None,
                uart_port: None,
            });
        }

        ios
    }

    // ========================================================================
    // SPI Bus Enumeration
    // ========================================================================

    /// Enumerate SPI device nodes from /dev/spidevX.Y.
    fn enumerate_spi_buses(&self) -> Vec<SpiBusInfo> {
        let mut results = Vec::new();

        let entries = match std::fs::read_dir("/dev") {
            Ok(e) => e,
            Err(e) => {
                debug!("Cannot read /dev for SPI enumeration: {}", e);
                return results;
            }
        };

        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with("spidev") {
                continue;
            }

            // Parse "spidevX.Y"
            let suffix = &name["spidev".len()..];
            if let Some(dot_pos) = suffix.find('.') {
                if let (Ok(bus), Ok(cs)) = (
                    suffix[..dot_pos].parse::<u8>(),
                    suffix[dot_pos + 1..].parse::<u8>(),
                ) {
                    results.push(SpiBusInfo {
                        device_path: format!("/dev/{}", name),
                        bus,
                        chip_select: cs,
                    });
                }
            }
        }

        results.sort_by_key(|s| (s.bus, s.chip_select));
        debug!("Found {} SPI devices", results.len());
        results
    }

    /// Convert an SPI bus info into a DiscoveredIo entry.
    fn spi_to_discovered_ios(&self, spi: &SpiBusInfo) -> Vec<DiscoveredIo> {
        vec![DiscoveredIo {
            tag_name: format!("SPI_{}_CS{}", spi.bus, spi.chip_select),
            io_type: "AI".to_string(),
            data_type: "FLOAT32".to_string(),
            module_address: spi.bus as u32,
            channel: spi.chip_select as u32,
            description: format!(
                "SPI bus {} chip select {} ({})",
                spi.bus, spi.chip_select, spi.device_path
            ),
            gpio_pin: None,
            source: "spi".to_string(),
            bus_type: Some("spi".to_string()),
            i2c_bus: None,
            i2c_address: None,
            i2c_device_name: None,
            spi_bus: Some(spi.bus),
            spi_cs: Some(spi.chip_select),
            uart_port: None,
        }]
    }

    // ========================================================================
    // UART Port Enumeration
    // ========================================================================

    /// Enumerate UART serial ports from /dev/tty*.
    fn enumerate_uart_ports(&self) -> Vec<UartPortInfo> {
        let mut results = Vec::new();

        let entries = match std::fs::read_dir("/dev") {
            Ok(e) => e,
            Err(e) => {
                debug!("Cannot read /dev for UART enumeration: {}", e);
                return results;
            }
        };

        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();

            let port_type = if name.starts_with("ttyAMA") {
                "hardware"
            } else if name.starts_with("ttyS") {
                "software"
            } else if name.starts_with("ttyUSB") {
                "usb-serial"
            } else if name.starts_with("ttyACM") {
                "usb-acm"
            } else {
                continue;
            };

            results.push(UartPortInfo {
                device_path: format!("/dev/{}", name),
                port_type: port_type.to_string(),
            });
        }

        results.sort_by(|a, b| a.device_path.cmp(&b.device_path));
        debug!("Found {} UART ports", results.len());
        results
    }

    /// Convert a UART port info into a DiscoveredIo entry.
    fn uart_to_discovered_ios(&self, uart: &UartPortInfo) -> Vec<DiscoveredIo> {
        let name = uart
            .device_path
            .strip_prefix("/dev/")
            .unwrap_or(&uart.device_path);

        vec![DiscoveredIo {
            tag_name: format!("UART_{}", name),
            io_type: "AI".to_string(),
            data_type: "FLOAT32".to_string(),
            module_address: 0,
            channel: 0,
            description: format!("UART {} port ({})", uart.port_type, uart.device_path),
            gpio_pin: None,
            source: "uart".to_string(),
            bus_type: Some("uart".to_string()),
            i2c_bus: None,
            i2c_address: None,
            i2c_device_name: None,
            spi_bus: None,
            spi_cs: None,
            uart_port: Some(uart.device_path.clone()),
        }]
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
    fn test_rpi_gpio_discovery() {
        let scanner = HardwareScanner::new(GpioPlatform::RaspberryPi);
        let ios = scanner.discover_rpi_gpio();
        assert_eq!(ios.len(), 26);
        assert_eq!(ios[0].tag_name, "GPIO_02");
        assert_eq!(ios[0].gpio_pin, Some(2));
        assert_eq!(ios[25].tag_name, "GPIO_27");
    }

    // ---- Revolution Pi discovery through the piControl ioctl ----------------

    fn scan_of(
        kernel: &std::sync::Arc<crate::picontrol::fake::FakeKernel>,
    ) -> (Vec<PiControlModule>, Vec<DiscoveredIo>) {
        let pi = crate::picontrol::device::PiControl::new(kernel.open());
        let map = crate::picontrol::rsc::ProcessMap::parse(
            crate::picontrol::rsc::sample::rsc().as_bytes(),
        )
        .unwrap();
        HardwareScanner::new(GpioPlatform::RevolutionPi).discover_picontrol(&pi, Some(&map))
    }

    #[test]
    fn the_modules_come_from_the_driver_device_list() {
        let kernel = crate::picontrol::fake::FakeKernel::sample();
        let (modules, _) = scan_of(&kernel);
        let names: Vec<&str> = modules.iter().map(|m| m.device_name.as_str()).collect();
        assert_eq!(names, ["RevPi Connect 4", "RevPi DIO", "RevPi AIO"]);
        assert_eq!(modules[1].offset, 100);
    }

    #[test]
    fn channels_follow_config_rsc_with_its_addresses_and_bits() {
        let kernel = crate::picontrol::fake::FakeKernel::sample();
        let (_, ios) = scan_of(&kernel);
        let io = |name: &str| ios.iter().find(|i| i.tag_name == name).unwrap();
        let o2 = io("O_2");
        assert_eq!(
            (
                o2.io_type.as_str(),
                o2.data_type.as_str(),
                o2.module_address,
                o2.channel
            ),
            ("DO", "BOOL", 122, 1)
        );
        let i9 = io("I_9");
        assert_eq!((i9.module_address, i9.channel), (101, 0));
        let level = io("InputValue_1");
        assert_eq!(
            (
                level.io_type.as_str(),
                level.data_type.as_str(),
                level.module_address
            ),
            ("AI", "UINT16", 200)
        );
        let out = io("OutputValue_1");
        assert_eq!(
            (out.io_type.as_str(), out.data_type.as_str()),
            ("AO", "UINT16")
        );
        assert!(out.bus_type.is_none() && out.i2c_bus.is_none() && out.uart_port.is_none());
        assert_eq!(out.source, "picontrol");
    }

    #[test]
    fn the_base_module_outputs_exported_outputs_and_module_memory_are_not_channels() {
        let kernel = crate::picontrol::fake::FakeKernel::sample();
        let (_, ios) = scan_of(&kernel);
        for hidden in ["RevPiOutput", "RevPiLED", "O_3", "Counter_1"] {
            assert!(
                ios.iter().all(|i| i.tag_name != hidden),
                "{hidden} must not be offered as a channel"
            );
        }
        assert!(
            ios.iter().any(|i| i.tag_name == "RevPiStatus"),
            "the base module's inputs are readable"
        );
    }

    #[test]
    fn a_module_that_is_not_connected_offers_no_channels() {
        let kernel = crate::picontrol::fake::FakeKernel::sample();
        kernel.set_module_active(33, false);
        let (modules, ios) = scan_of(&kernel);
        assert!(modules.iter().all(|m| m.device_name != "RevPi AIO"));
        assert!(ios.iter().all(|i| !i.tag_name.starts_with("InputValue")));
    }

    #[test]
    fn without_a_config_rsc_the_scan_lists_modules_and_invents_no_channels() {
        let kernel = crate::picontrol::fake::FakeKernel::sample();
        let pi = crate::picontrol::device::PiControl::new(kernel.open());
        let (modules, ios) =
            HardwareScanner::new(GpioPlatform::RevolutionPi).discover_picontrol(&pi, None);
        assert_eq!(modules.len(), 3);
        assert!(ios.is_empty());
    }

    #[test]
    fn a_driver_that_is_resetting_is_no_modules() {
        let kernel = crate::picontrol::fake::FakeKernel::sample();
        kernel.begin_reset();
        let (modules, ios) = scan_of(&kernel);
        assert!(modules.is_empty() && ios.is_empty());
    }

    #[test]
    fn other_platforms_do_not_touch_the_device() {
        let (modules, ios) = HardwareScanner::new(GpioPlatform::RaspberryPi).scan_picontrol();
        assert!(modules.is_empty() && ios.is_empty());
    }

    #[test]
    fn no_helper_process_is_executed_by_the_scanner() {
        let src = include_str!("hardware_scanner.rs");
        let production = src.split("#[cfg(test)]\nmod tests").next().unwrap();
        assert!(!production.contains("std::process::Command::new(\"/usr/bin/piTest"));
        assert!(!production.contains("piTest -d"));
    }

    #[test]
    fn test_identify_i2c_device() {
        let bme = identify_i2c_device(0x76);
        assert!(bme.is_some());
        let (name, _, io, dt) = bme.unwrap();
        assert_eq!(name, "BME280");
        assert_eq!(io, "AI");
        assert_eq!(dt, "FLOAT32");

        let atlas_ph = identify_i2c_device(0x63);
        assert!(atlas_ph.is_some());
        assert_eq!(atlas_ph.unwrap().0, "ATLAS_PH");

        let pcf = identify_i2c_device(0x20);
        assert!(pcf.is_some());
        assert_eq!(pcf.unwrap().0, "PCF8574");
        assert_eq!(pcf.unwrap().2, "DI");

        assert!(identify_i2c_device(0x01).is_none());
    }

    #[test]
    fn test_i2c_bus_to_discovered_ios() {
        let scanner = HardwareScanner::new(GpioPlatform::RaspberryPi);
        let bus_info = I2cBusScanInfo {
            bus: 1,
            device_count: 2,
            devices: vec![
                I2cDeviceInfo {
                    address: 0x76,
                    address_hex: "0x76".to_string(),
                    device_name: Some("BME280".to_string()),
                    device_description: Some("Temperature/Humidity/Pressure sensor".to_string()),
                },
                I2cDeviceInfo {
                    address: 0x55,
                    address_hex: "0x55".to_string(),
                    device_name: None,
                    device_description: None,
                },
            ],
        };

        let ios = scanner.i2c_bus_to_discovered_ios(&bus_info);
        assert_eq!(ios.len(), 2);
        // Known device — Batch 85 fix of ORPHAN-HIGH-013 #4:
        // tag_name production format is `{name}_B{bus}_{addr}`
        // (vs the old test's bare `{name}`). Bus + address
        // suffix disambiguates the SAME chip appearing on
        // multiple buses OR at different addresses on one bus
        // (common in multi-sensor I2C deployments). Test
        // updated to match production format.
        assert_eq!(ios[0].tag_name, "BME280_B1_0x76");
        assert_eq!(ios[0].io_type, "AI");
        assert_eq!(ios[0].source, "i2c");
        assert_eq!(ios[0].bus_type, Some("i2c".to_string()));
        assert_eq!(ios[0].i2c_bus, Some(1));
        assert_eq!(ios[0].i2c_address, Some(0x76));
        assert_eq!(ios[0].i2c_device_name, Some("BME280".to_string()));
        // Unknown device — production format `I2C_B{bus}_{addr}`
        // (was `I2C_{bus}_{addr}` in the old test which
        // missed the `B` bus-prefix consistency with the
        // known-device path).
        assert_eq!(ios[1].tag_name, "I2C_B1_0x55");
        assert!(ios[1].i2c_device_name.is_none());
    }

    #[test]
    fn test_spi_to_discovered_ios() {
        let scanner = HardwareScanner::new(GpioPlatform::RaspberryPi);
        let spi = SpiBusInfo {
            device_path: "/dev/spidev0.0".to_string(),
            bus: 0,
            chip_select: 0,
        };

        let ios = scanner.spi_to_discovered_ios(&spi);
        assert_eq!(ios.len(), 1);
        assert_eq!(ios[0].tag_name, "SPI_0_CS0");
        assert_eq!(ios[0].source, "spi");
        assert_eq!(ios[0].bus_type, Some("spi".to_string()));
        assert_eq!(ios[0].spi_bus, Some(0));
        assert_eq!(ios[0].spi_cs, Some(0));
    }

    #[test]
    fn test_uart_to_discovered_ios() {
        let scanner = HardwareScanner::new(GpioPlatform::RaspberryPi);
        let uart = UartPortInfo {
            device_path: "/dev/ttyUSB0".to_string(),
            port_type: "usb-serial".to_string(),
        };

        let ios = scanner.uart_to_discovered_ios(&uart);
        assert_eq!(ios.len(), 1);
        assert_eq!(ios[0].tag_name, "UART_ttyUSB0");
        assert_eq!(ios[0].source, "uart");
        assert_eq!(ios[0].bus_type, Some("uart".to_string()));
        assert_eq!(ios[0].uart_port, Some("/dev/ttyUSB0".to_string()));
    }

    #[test]
    fn test_rpi_gpio_has_none_bus_fields() {
        let scanner = HardwareScanner::new(GpioPlatform::RaspberryPi);
        let ios = scanner.discover_rpi_gpio();
        for io in &ios {
            assert!(io.bus_type.is_none());
            assert!(io.i2c_bus.is_none());
            assert!(io.spi_bus.is_none());
            assert!(io.uart_port.is_none());
        }
    }
}
