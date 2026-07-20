//! Inactive Marine analysis worker binary.
//!
//! Bootstrap validates the locked configuration and exits without
//! creating a NATS connection, JetStream consumer, provider request, or
//! child process. Promotion to a long-running worker requires replacing
//! this entrypoint together with the production capacity and deployment
//! acceptance gates.

#![forbid(unsafe_code)]
#![deny(missing_docs)]

use std::process::ExitCode;

use marine_analysis_worker::WorkerConfig;

fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .json()
        .with_ansi(false)
        .with_max_level(tracing::Level::INFO)
        .init();

    match WorkerConfig::from_env() {
        Ok(config) => {
            debug_assert!(!config.is_active());
            ExitCode::SUCCESS
        }
        Err(error) => {
            tracing::error!(
                error_code = error.code(),
                "marine analysis worker configuration rejected"
            );
            ExitCode::from(2)
        }
    }
}
