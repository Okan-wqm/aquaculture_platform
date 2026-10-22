//! `set_output` on a RevPi process-image tag (ADR-048 DEC-8.8): the command
//! reaches the output only through the handle's degraded-mode gate, force
//! registry and output grant, and stores what was read back, not the commanded
//! value a second time through the tag's scaling.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

use std::sync::Arc;

use serde_json::json;
use tokio::sync::RwLock;

use super::CommandHandler;
use crate::AppState;
use crate::degraded::{Backend, DegradedReason};
use crate::picontrol::device::Opener;
use crate::picontrol::fake::FakeKernel;
use crate::picontrol::rsc::sample;
use crate::picontrol::{PiControlHandle, RscSource};

const GRANT: &str = r#"
output_watchdog_ms: 1000
points:
  - tag: pump
    variable: O_1
    direction: output
  - tag: valve
    variable: OutputValue_1
    direction: output
    raw_min: 0
    raw_max: 10000
    eng_min: 0
    eng_max: 10
  - tag: in_1
    variable: I_1
"#;

struct Rig {
    kernel: Arc<FakeKernel>,
    state: Arc<RwLock<AppState>>,
    handler: CommandHandler,
}

async fn rig() -> Rig {
    let config: crate::config::AgentConfig = serde_yaml::from_str(
        "device_id: \"123e4567-e89b-42d3-a456-426614174000\"\ndevice_code: \"REVPI-1\"\n\
         api_url: \"https://api.example.test\"\nmqtt:\n  broker: \"localhost\"\n  port: 1883\n",
    )
    .unwrap();
    let mut app = AppState::new(config);
    let kernel = FakeKernel::sample();
    let opener: Opener = {
        let k = kernel.clone();
        Arc::new(move || Ok(k.open()))
    };
    let handle = PiControlHandle::open(
        &serde_yaml::from_str(GRANT).unwrap(),
        250,
        RscSource::Verified(sample::rsc().into_bytes().into()),
        app.degraded.control_gate(),
        app.force_registry.clone(),
        opener,
    )
    .unwrap();
    app.process_image
        .set_picontrol_configs(handle.tag_configs())
        .await;
    app.picontrol_handle = Some(handle);
    let state = Arc::new(RwLock::new(app));
    let handler = CommandHandler::new(state.clone()).await;
    Rig {
        kernel,
        state,
        handler,
    }
}

#[tokio::test]
async fn set_output_drives_the_bit_and_publishes_the_tag() {
    let mut r = rig().await;
    let (ok, data, err) = r
        .handler
        .cmd_set_output(&json!({"tag_name": "pump", "value": 1}))
        .await;
    assert!(ok, "{err:?}");
    assert_eq!(data["tag_name"], "pump");
    assert_eq!(r.kernel.peek(122) & 1, 1);
    let tag = r
        .state
        .read()
        .await
        .process_image
        .get_tag("pump")
        .await
        .unwrap();
    assert_eq!(tag.value, 1.0);
}

#[tokio::test]
async fn an_analog_output_is_scaled_back_once_and_published_in_engineering_units() {
    let mut r = rig().await;
    let (ok, _, err) = r
        .handler
        .cmd_set_output(&json!({"tag_name": "valve", "value": 5.0}))
        .await;
    assert!(ok, "{err:?}");
    // 5.0 of 0..10 is raw 5000 = 0x1388, little endian at 210.
    assert_eq!((r.kernel.peek(210), r.kernel.peek(211)), (0x88, 0x13));
    let tag = r
        .state
        .read()
        .await
        .process_image
        .get_tag("valve")
        .await
        .unwrap();
    assert_eq!(tag.value, 5.0, "scaled once: 5000 raw is 5.0, not 0.005");
}

#[tokio::test]
async fn a_value_outside_the_variable_is_refused_and_writes_nothing() {
    let mut r = rig().await;
    let (ok, _, err) = r
        .handler
        .cmd_set_output(&json!({"tag_name": "valve", "value": 70.0}))
        .await;
    assert!(!ok);
    assert!(
        err.unwrap().contains("outside"),
        "range error names the range"
    );
    assert_eq!((r.kernel.peek(210), r.kernel.peek(211)), (0, 0));
}

#[tokio::test]
async fn an_input_tag_is_not_an_output() {
    let mut r = rig().await;
    let (ok, _, err) = r
        .handler
        .cmd_set_output(&json!({"tag_name": "in_1", "value": 1}))
        .await;
    assert!(!ok);
    assert!(err.unwrap().contains("not an output"));
    assert_eq!(r.kernel.peek(100), 0);
}

#[tokio::test]
async fn degraded_mode_refuses_the_command_and_holds_the_output() {
    let mut r = rig().await;
    r.state
        .read()
        .await
        .degraded
        .enter(DegradedReason::BackendUnavailable {
            backend: Backend::Gpio,
            detail: "gpio is gone".into(),
        });
    let (ok, _, err) = r
        .handler
        .cmd_set_output(&json!({"tag_name": "pump", "value": 1}))
        .await;
    assert!(!ok);
    assert!(err.unwrap().contains("control is disabled"));
    assert_eq!(r.kernel.peek(122) & 1, 0);
}

#[tokio::test]
async fn a_forced_output_is_not_overwritten_by_the_command() {
    let mut r = rig().await;
    r.state
        .read()
        .await
        .force_registry
        .apply(
            "pump".into(),
            0.0,
            crate::process_image::TagQuality::Good,
            "operator".into(),
            "maintenance".into(),
            60,
            false,
            &crate::runtime_safety::system_clock::SystemClockAuthority::new(),
        )
        .await
        .unwrap();
    let (ok, _, err) = r
        .handler
        .cmd_set_output(&json!({"tag_name": "pump", "value": 1}))
        .await;
    assert!(!ok);
    assert!(err.unwrap().contains("forced value"));
    assert_eq!(r.kernel.peek(122) & 1, 0);
}

#[tokio::test]
async fn a_build_without_a_handle_refuses() {
    let mut r = rig().await;
    r.state.write().await.picontrol_handle = None;
    let (ok, _, err) = r
        .handler
        .cmd_set_output(&json!({"tag_name": "pump", "value": 1}))
        .await;
    assert!(!ok);
    assert!(err.unwrap().contains("piControl handle not available"));
}
