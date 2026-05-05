//! commands::plc — PLC programming command handlers.
//!
//! ## Why this is a directory (Batch #303 ULTRA-HIGH-013 ceiling)
//!
//! Pre-Batch-#303 a single 856-line `commands/plc.rs` file
//! violated the ≤500-line ceiling per ULTRA-HIGH-013. Split
//! into 4 sibling files keyed by command-class:
//!
//!   upload.rs     — cmd_plc_upload + upload_with_client
//!   status.rs     — cmd_plc_status + get_status_with_client
//!   lifecycle.rs  — cmd_plc_start + cmd_plc_stop + helpers
//!   catalog.rs    — cmd_plc_list + cmd_plc_download +
//!                   cmd_plc_delete + helpers
//!
//! Each sub-file adds an `impl super::super::CommandHandler`
//! block; method visibility remains `pub(super)` so the
//! commands::dispatch_lifecycle match arms call them unchanged
//! from the pre-split shape.
//!
//! ## Shared architectural concerns
//!
//! SECURITY: Every upload/download path rejects loopback /
//! link-local / broadcast / unspecified addresses to prevent
//! accidental or malicious self-targeting. The address check
//! lives inside each handler's param-parse phase to fail-fast
//! before any client connection is attempted. This contract
//! lives PER-FILE (each file's handlers run their own checks)
//! because the address validation is intrinsic to handler
//! parameter validation, not to a cross-cutting policy layer.
//!
//! AUTH: Codesys + OPC UA clients accept optional
//! username/password credentials from params. Stored in-memory
//! only for the duration of the upload — no persistence layer.
//! Sprint 6.x hardening target: wrap creds in
//! `secrecy::Secret<String>` + zeroize-on-drop per ADR-018 §5.

mod upload;
mod status;
mod lifecycle;
mod catalog;
