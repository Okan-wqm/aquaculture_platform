//! Harness that boots the real agent binary (generic profile) the way
//! systemd runs a `Type=notify` unit, for the ADR-048 DEC-6 liveness tests
//! (`tests/invariants/sd_notify_no_unset_env.rs`,
//! `tests/invariants/ready_after_safe_state.rs`,
//! `tests/offline_boot_safe_state.rs`).
//!
//! * [`NotifySocket`] — a real `AF_UNIX` datagram socket standing in for
//!   systemd's notify socket; every datagram is recorded with its arrival
//!   time.
//! * [`ModbusServer`] — a minimal Modbus-TCP slave that records every write
//!   (FC05/06/15/16) with its arrival time and answers reads from the values
//!   written, so the agent's readback verification passes.
//! * [`Device`] — a temporary device tree (config, data root, device secret,
//!   machine-id) and the agent process started with `NOTIFY_SOCKET`,
//!   `WATCHDOG_USEC` and `WATCHDOG_PID` (set by `exec` from a shell, so it is
//!   the agent's own pid, exactly as systemd sets it).

#![allow(dead_code)]

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::net::UnixDatagram;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------
// systemd notify socket
// ---------------------------------------------------------------------------

/// A datagram the agent sent to the notify socket.
#[derive(Debug, Clone)]
pub struct Datagram {
    pub at: Instant,
    pub text: String,
}

impl Datagram {
    pub fn is_ready(&self) -> bool {
        self.text.lines().any(|l| l == "READY=1")
    }
    pub fn is_watchdog(&self) -> bool {
        self.text.lines().any(|l| l == "WATCHDOG=1")
    }
    pub fn status(&self) -> Option<&str> {
        self.text.lines().find_map(|l| l.strip_prefix("STATUS="))
    }
}

/// systemd's notify socket, played by the test.
pub struct NotifySocket {
    pub path: PathBuf,
    received: Arc<Mutex<Vec<Datagram>>>,
    stop: Arc<AtomicBool>,
}

impl NotifySocket {
    pub fn bind(dir: &Path) -> Self {
        let path = dir.join("notify.sock");
        let socket = UnixDatagram::bind(&path).expect("bind notify socket");
        socket
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("read timeout");
        let received = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        {
            let received = received.clone();
            let stop = stop.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                while !stop.load(Ordering::Acquire) {
                    if let Ok(n) = socket.recv(&mut buf) {
                        let text = String::from_utf8_lossy(&buf[..n]).into_owned();
                        received.lock().expect("lock").push(Datagram {
                            at: Instant::now(),
                            text,
                        });
                    }
                }
            });
        }
        Self {
            path,
            received,
            stop,
        }
    }

    pub fn all(&self) -> Vec<Datagram> {
        self.received.lock().expect("lock").clone()
    }

    /// The first datagram matching `pred`, waiting up to `timeout`.
    pub fn wait_for(
        &self,
        timeout: Duration,
        pred: impl Fn(&Datagram) -> bool,
    ) -> Option<Datagram> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(d) = self.all().into_iter().find(|d| pred(d)) {
                return Some(d);
            }
            if Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Watchdog pings received after `after`.
    pub fn watchdogs_after(&self, after: Instant) -> usize {
        self.all()
            .iter()
            .filter(|d| d.at >= after && d.is_watchdog())
            .count()
    }
}

impl Drop for NotifySocket {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}

// ---------------------------------------------------------------------------
// Modbus-TCP slave
// ---------------------------------------------------------------------------

/// A write the slave received.
#[derive(Debug, Clone, PartialEq)]
pub enum ModbusWrite {
    Coil { address: u16, value: bool },
    Register { address: u16, value: u16 },
}

#[derive(Debug, Clone)]
pub struct RecordedWrite {
    pub at: Instant,
    pub write: ModbusWrite,
}

#[derive(Default)]
struct Image {
    coils: HashMap<u16, bool>,
    registers: HashMap<u16, u16>,
}

/// Minimal Modbus-TCP slave on 127.0.0.1.
pub struct ModbusServer {
    pub port: u16,
    writes: Arc<Mutex<Vec<RecordedWrite>>>,
}

impl ModbusServer {
    pub fn start() -> Self {
        Self::start_on(0)
    }

    /// Listen on `port` (0 = any free port); a device that comes up after the
    /// agent started is a server started later on a port the agent already
    /// knows (`closed_port`).
    pub fn start_on(port: u16) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", port)).expect("bind modbus");
        let port = listener.local_addr().expect("addr").port();
        let writes = Arc::new(Mutex::new(Vec::new()));
        let image = Arc::new(Mutex::new(Image::default()));
        {
            let writes = writes.clone();
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(stream) = stream else { continue };
                    let writes = writes.clone();
                    let image = image.clone();
                    std::thread::spawn(move || serve(stream, &writes, &image));
                }
            });
        }
        Self { port, writes }
    }

    pub fn writes(&self) -> Vec<RecordedWrite> {
        self.writes.lock().expect("lock").clone()
    }

    /// Wait until `n` writes arrived.
    pub fn wait_writes(&self, n: usize, timeout: Duration) -> Vec<RecordedWrite> {
        let deadline = Instant::now() + timeout;
        loop {
            let w = self.writes();
            if w.len() >= n || Instant::now() >= deadline {
                return w;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

fn u16_at(b: &[u8], i: usize) -> u16 {
    u16::from_be_bytes([b[i], b[i + 1]])
}

fn serve(mut stream: TcpStream, writes: &Mutex<Vec<RecordedWrite>>, image: &Mutex<Image>) {
    loop {
        let mut header = [0u8; 7];
        if stream.read_exact(&mut header).is_err() {
            return;
        }
        let len = usize::from(u16_at(&header, 4));
        if len < 2 {
            return;
        }
        let mut pdu = vec![0u8; len - 1];
        if stream.read_exact(&mut pdu).is_err() {
            return;
        }
        let fc = pdu[0];
        let now = Instant::now();
        let response: Vec<u8> = {
            let mut img = image.lock().expect("lock");
            match fc {
                1 | 2 => {
                    let (addr, qty) = (u16_at(&pdu, 1), u16_at(&pdu, 3));
                    let mut bytes = vec![0u8; usize::from(qty).div_ceil(8)];
                    for i in 0..qty {
                        if img.coils.get(&(addr + i)).copied().unwrap_or(false) {
                            bytes[usize::from(i / 8)] |= 1 << (i % 8);
                        }
                    }
                    let mut r = vec![fc, u8::try_from(bytes.len()).expect("byte count")];
                    r.extend(bytes);
                    r
                }
                3 | 4 => {
                    let (addr, qty) = (u16_at(&pdu, 1), u16_at(&pdu, 3));
                    let mut r = vec![fc, u8::try_from(qty * 2).expect("byte count")];
                    for i in 0..qty {
                        let v = img.registers.get(&(addr + i)).copied().unwrap_or(0);
                        r.extend(v.to_be_bytes());
                    }
                    r
                }
                5 => {
                    let (addr, raw) = (u16_at(&pdu, 1), u16_at(&pdu, 3));
                    let value = raw == 0xFF00;
                    img.coils.insert(addr, value);
                    writes.lock().expect("lock").push(RecordedWrite {
                        at: now,
                        write: ModbusWrite::Coil {
                            address: addr,
                            value,
                        },
                    });
                    pdu.clone()
                }
                6 => {
                    let (addr, value) = (u16_at(&pdu, 1), u16_at(&pdu, 3));
                    img.registers.insert(addr, value);
                    writes.lock().expect("lock").push(RecordedWrite {
                        at: now,
                        write: ModbusWrite::Register {
                            address: addr,
                            value,
                        },
                    });
                    pdu.clone()
                }
                15 => {
                    let (addr, qty) = (u16_at(&pdu, 1), u16_at(&pdu, 3));
                    for i in 0..qty {
                        let byte = pdu[6 + usize::from(i / 8)];
                        let value = byte & (1 << (i % 8)) != 0;
                        img.coils.insert(addr + i, value);
                        writes.lock().expect("lock").push(RecordedWrite {
                            at: now,
                            write: ModbusWrite::Coil {
                                address: addr + i,
                                value,
                            },
                        });
                    }
                    pdu[..5].to_vec()
                }
                16 => {
                    let (addr, qty) = (u16_at(&pdu, 1), u16_at(&pdu, 3));
                    for i in 0..qty {
                        let value = u16_at(&pdu, 6 + 2 * usize::from(i));
                        img.registers.insert(addr + i, value);
                        writes.lock().expect("lock").push(RecordedWrite {
                            at: now,
                            write: ModbusWrite::Register {
                                address: addr + i,
                                value,
                            },
                        });
                    }
                    pdu[..5].to_vec()
                }
                other => vec![other | 0x80, 0x01],
            }
        };
        let mut out = Vec::with_capacity(7 + response.len());
        out.extend(&header[..4]);
        out.extend(
            u16::try_from(response.len() + 1)
                .expect("len")
                .to_be_bytes(),
        );
        out.push(header[6]);
        out.extend(response);
        if stream.write_all(&out).is_err() {
            return;
        }
    }
}

/// A TCP port on 127.0.0.1 with nothing listening.
pub fn closed_port() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = l.local_addr().expect("addr").port();
    drop(l);
    port
}

/// YAML for a Modbus-TCP output device at `port` with two coils (one
/// fail-ON) and a holding register.
pub fn modbus_output_device(name: &str, port: u16) -> String {
    format!(
        r#"  - name: "{name}"
    connection_type: tcp
    address: "127.0.0.1:{port}"
    slave_id: 1
    security:
      allow_writes: true
      allow_all_write_addresses: true
      allowed_function_codes: [1, 2, 3, 4, 5, 6, 15, 16]
    registers:
      - name: aerator
        address: 10
        register_type: coil
        data_type: u16
        safe_state_value: 1
      - name: feeder
        address: 11
        register_type: coil
        data_type: u16
      - name: dosing_setpoint
        address: 20
        register_type: holding
        data_type: u16
        safe_state_value: 123
"#
    )
}

/// YAML for a Modbus-TCP relay bank at `port` with `coils` coil outputs
/// (addresses 30.., every other one fail-ON), configured the way an operator
/// does: `allow_writes` and the all-address opt-in, and the default
/// function-code whitelist (EDGE-HIGH-131, EDGE-MEDIUM-134).
pub fn modbus_relay_bank(name: &str, port: u16, coils: u16) -> String {
    let mut yaml = format!(
        r#"  - name: "{name}"
    connection_type: tcp
    address: "127.0.0.1:{port}"
    slave_id: 1
    security:
      allow_writes: true
      allow_all_write_addresses: true
    registers:
"#
    );
    for i in 0..coils {
        yaml.push_str(&format!(
            "      - name: relay_{i}\n        address: {}\n        register_type: coil\n        \
             data_type: u16\n        safe_state_value: {}\n",
            30 + i,
            u8::from(i % 2 == 0)
        ));
    }
    yaml
}

// ---------------------------------------------------------------------------
// Device + agent process
// ---------------------------------------------------------------------------

/// The configuration shape of a test device.
pub struct DeviceConfig {
    /// Broker credential present (activated) or not (activation pending).
    pub activated: bool,
    /// Extra top-level YAML appended verbatim (`modbus:`, `gpio:` ...).
    pub extra_yaml: String,
}

/// A device tree in a temporary directory and its agent process.
pub struct Device {
    pub root: tempfile::TempDir,
    pub config: PathBuf,
    pub data: PathBuf,
    pub notify: NotifySocket,
    child: Option<Child>,
}

impl Device {
    pub fn new(cfg: &DeviceConfig) -> Self {
        let root = tempfile::tempdir().expect("tempdir");
        let etc = root.path().join("etc");
        let data = root.path().join("data");
        std::fs::create_dir_all(&etc).expect("etc");
        std::fs::create_dir_all(&data).expect("data");
        let config = etc.join("config.yaml");
        let api_port = closed_port();
        let broker_port = closed_port();
        let credential = if cfg.activated {
            format!(
                "tenant_id: \"1f3e5d7c-9b2a-4c6e-8f0d-1a3b5c7d9e2f\"\nmqtt:\n  broker: \
                 \"127.0.0.1\"\n  port: {broker_port}\n  username: \"device-test\"\n  \
                 password: \"TEST-ONLY-password\"\n  tls:\n    enabled: false\n"
            )
        } else {
            "provisioning_token: \"TEST-ONLY-provisioning-token\"\nmqtt:\n  tls:\n    enabled: false\n"
                .to_string()
        };
        let yaml = format!(
            "device_id: \"9b2f6c1e-4a7d-4e3b-8c5f-2d1a0e9f7b6c\"\ndevice_code: \"RPI-DEC6\"\n\
             api_url: \"http://127.0.0.1:{api_port}\"\n{credential}{}",
            cfg.extra_yaml
        );
        std::fs::write(&config, yaml).expect("write config");
        std::fs::write(data.join("db.key"), [0x42u8; 32]).expect("db.key");
        std::fs::write(
            root.path().join("machine-id"),
            "0123456789abcdef0123456789abcdef\n",
        )
        .expect("machine-id");
        let notify = NotifySocket::bind(root.path());
        Self {
            root,
            config,
            data,
            notify,
            child: None,
        }
    }

    /// Start the agent as systemd would: `NOTIFY_SOCKET`, `WATCHDOG_USEC`,
    /// and `WATCHDOG_PID` naming the agent itself (`exec` keeps the shell's
    /// pid).
    pub fn start(&mut self, watchdog: Duration) {
        let log = std::fs::File::create(self.root.path().join("agent.log")).expect("log");
        let log_err = log.try_clone().expect("log clone");
        let child = Command::new("/bin/sh")
            .arg("-c")
            .arg("WATCHDOG_PID=$$; export WATCHDOG_PID; exec \"$0\"")
            .arg(env!("CARGO_BIN_EXE_suderra-agent"))
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("SUDERRA_CONFIG", &self.config)
            .env("SUDERRA_DATA_DIR", &self.data)
            .env("SUDERRA_DB_KEY_PATH", self.data.join("db.key"))
            .env(
                "SUDERRA_MACHINE_ID_PATH",
                self.root.path().join("machine-id"),
            )
            .env("NOTIFY_SOCKET", &self.notify.path)
            .env("WATCHDOG_USEC", watchdog.as_micros().to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log_err))
            .spawn()
            .expect("spawn agent");
        self.child = Some(child);
    }

    pub fn log(&self) -> String {
        std::fs::read_to_string(self.root.path().join("agent.log")).unwrap_or_default()
    }

    /// The agent is still running.
    pub fn alive(&mut self) -> bool {
        match self.child.as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(None)),
            None => false,
        }
    }

    /// The health view the agent publishes (generic profile: state dir).
    pub fn health(&self) -> serde_json::Value {
        let path = self.data.join("state").join("health.json");
        let bytes = std::fs::read(&path)
            .unwrap_or_else(|e| panic!("health view {}: {e}\n{}", path.display(), self.log()));
        serde_json::from_slice(&bytes).expect("health json")
    }

    /// Wait for READY or fail with the agent log.
    pub fn wait_ready(&mut self, timeout: Duration) -> Datagram {
        match self.notify.wait_for(timeout, Datagram::is_ready) {
            Some(d) => d,
            None => {
                let alive = self.alive();
                panic!(
                    "no READY=1 within {timeout:?} (agent alive: {alive})\ndatagrams: {:?}\nlog:\n{}",
                    self.notify.all(),
                    self.log()
                )
            }
        }
    }

    /// SIGTERM and wait; the exit status.
    pub fn stop(&mut self) -> Option<std::process::ExitStatus> {
        let mut child = self.child.take()?;
        let pid = i32::try_from(child.id()).expect("pid");
        // SAFETY: plain kill(2) on our own child.
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if let Ok(Some(status)) = child.try_wait() {
                return Some(status);
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                return child.wait().ok();
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for Device {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
