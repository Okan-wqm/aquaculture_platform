//! Atlas Scientific EZO I2C sensor driver
//!
//! Supports pH, DO, EC, ORP, and Temperature EZO circuits.
//! Protocol: Write "R" command → wait delay → read 32 bytes → parse ASCII response.

use anyhow::Result;
use tracing::{debug, warn};

use crate::i2c::I2cHandle;
use crate::process_image::{AtlasEzoType, TagQuality};

/// Atlas Scientific EZO I2C driver
pub struct AtlasEzoDriver {
    i2c: I2cHandle,
}

impl AtlasEzoDriver {
    pub fn new(i2c: I2cHandle) -> Self {
        Self { i2c }
    }

    /// Read a measurement from an EZO sensor
    ///
    /// EZO protocol:
    /// 1. Write "R" command to trigger a reading
    /// 2. Wait for processing (600ms for most, 900ms for EC)
    /// 3. Read 32 bytes response
    /// 4. Parse: `byte[0]` = status code, `byte[1..]` = ASCII float (null-terminated)
    pub async fn read_measurement(
        &self,
        device_name: &str,
        sensor_type: &AtlasEzoType,
    ) -> (f64, TagQuality) {
        // Step 1: Send "R" command
        let write_result = self.i2c.write_direct(device_name, b"R").await;
        if let Err(e) = write_result {
            warn!("EZO write failed for '{}': {}", device_name, e);
            return (0.0, TagQuality::CommFailure);
        }

        // Step 2: Wait for sensor processing
        let delay_ms = sensor_type.read_delay_ms();
        tokio::time::sleep(tokio::time::Duration::from_millis(delay_ms)).await;

        // Step 3: Read response (32 bytes)
        let result = self.i2c.read_direct(device_name, 32).await;
        if !result.success {
            warn!(
                "EZO read failed for '{}': {}",
                device_name,
                result.error.as_deref().unwrap_or("unknown error")
            );
            return (0.0, TagQuality::CommFailure);
        }

        // ARC-006: In simulation mode the I2C handle returns
        // all-zero data buffers with `success=true` + `simulated=
        // true`. The EZO response parser would reject the empty
        // status byte as `Bad`, which hides the simulation signal.
        // Short-circuit: return TagQuality::Simulated with a
        // stable placeholder value (0.0) so SCADA screens render
        // a visible "simulated" badge rather than a "bad" error.
        if result.simulated {
            return (0.0, TagQuality::Simulated);
        }

        if result.data.is_empty() {
            warn!("EZO empty response from '{}'", device_name);
            return (0.0, TagQuality::CommFailure);
        }

        self.parse_ezo_response(device_name, &result.data)
    }

    /// Parse EZO response bytes
    ///
    /// Response format:
    /// - `byte[0]`: 1 = success, 2 = syntax error, 254 = pending, 255 = no data
    /// - `byte[1..]`: null-terminated ASCII float string
    fn parse_ezo_response(&self, device_name: &str, data: &[u8]) -> (f64, TagQuality) {
        if data.is_empty() {
            warn!("EZO empty response buffer from '{}'", device_name);
            return (0.0, TagQuality::Bad);
        }

        let status = data[0];
        match status {
            1 => {
                // Success - parse ASCII float from remaining bytes
                let value_bytes: Vec<u8> = data
                    .get(1..)
                    .unwrap_or(&[])
                    .iter()
                    .take_while(|&&b| b != 0)
                    .copied()
                    .collect();

                match String::from_utf8(value_bytes) {
                    Ok(s) => match s.trim().parse::<f64>() {
                        Ok(value) => {
                            debug!("EZO '{}': {:.4}", device_name, value);
                            (value, TagQuality::Good)
                        }
                        Err(e) => {
                            warn!("EZO parse error for '{}': '{}' - {}", device_name, s, e);
                            (0.0, TagQuality::Bad)
                        }
                    },
                    Err(e) => {
                        warn!("EZO UTF-8 error for '{}': {}", device_name, e);
                        (0.0, TagQuality::Bad)
                    }
                }
            }
            2 => {
                warn!("EZO syntax error from '{}'", device_name);
                (0.0, TagQuality::Bad)
            }
            254 => {
                debug!("EZO pending from '{}' (not ready)", device_name);
                (0.0, TagQuality::Uncertain)
            }
            255 => {
                warn!("EZO no data from '{}'", device_name);
                (0.0, TagQuality::Bad)
            }
            other => {
                warn!("EZO unknown status {} from '{}'", other, device_name);
                (0.0, TagQuality::Bad)
            }
        }
    }

    /// Send a calibration command
    ///
    /// Calibration commands take longer (up to 1600ms).
    pub async fn calibrate(&self, device_name: &str, command: &str) -> Result<String> {
        // Send calibration command
        self.i2c
            .write_direct(device_name, command.as_bytes())
            .await?;

        // Calibration needs more time
        tokio::time::sleep(tokio::time::Duration::from_millis(1600)).await;

        // Read response
        let result = self.i2c.read_direct(device_name, 32).await;
        if !result.success {
            anyhow::bail!(
                "Calibration read failed for '{}': {}",
                device_name,
                result.error.as_deref().unwrap_or("unknown error")
            );
        }

        let status = result.data.first().copied().unwrap_or(255);
        if status == 1 {
            let response: Vec<u8> = result.data[1..]
                .iter()
                .take_while(|&&b| b != 0)
                .copied()
                .collect();
            Ok(String::from_utf8_lossy(&response).to_string())
        } else {
            anyhow::bail!(
                "Calibration failed for '{}': status code {}",
                device_name,
                status
            )
        }
    }
}
