//! systemd service-manager notifications (the `sd_notify(3)` datagram
//! protocol), owned by one value created at process start.
//!
//! ADR-048 DEC-6.1 / EDGE-CRITICAL-049.
//!
//! WHY a notifier of our own instead of the `sd-notify` crate: the crate
//! re-reads `NOTIFY_SOCKET` on every call and, with `unset_env = true`,
//! removes it from the environment. The agent's READY passed `true`, so every
//! later `WATCHDOG=1` silently went nowhere and systemd killed the agent once
//! per `WatchdogSec`. Removing an environment variable while the tokio worker
//! threads run is also a data race (`remove_var` is `unsafe` in edition 2024).
//!
//! WHAT: [`SystemdNotifier::from_env`] runs in `main` before the runtime
//! exists. It captures the socket address and the watchdog setting once; the
//! notifier then sends datagrams to that captured address for the whole run.
//! Nothing here can remove or change the environment, so the socket cannot be
//! lost (tier 1 — there is no flag to get wrong).
//!
//! INVARIANT: `tests/invariants/sd_notify_no_unset_env.rs` — no `notify(true`
//! and no `sd_notify` crate in `src/`, `NOTIFY_SOCKET` read only here, and the
//! real binary delivers READY and then repeated `WATCHDOG=1` to a real
//! datagram socket.

use std::io;
use std::path::PathBuf;
use std::time::Duration;

/// Where systemd listens for notifications.
#[derive(Debug, Clone, PartialEq, Eq)]
enum NotifyAddress {
    /// A filesystem socket (`NOTIFY_SOCKET=/run/systemd/notify`).
    Path(PathBuf),
    /// A Linux abstract-namespace socket (`NOTIFY_SOCKET=@name`).
    Abstract(Vec<u8>),
}

/// The notification channel to the service manager of this process.
#[derive(Debug, Clone)]
pub struct SystemdNotifier {
    address: Option<NotifyAddress>,
    watchdog: Option<Duration>,
    /// Why a present `NOTIFY_SOCKET` / `WATCHDOG_USEC` was not usable; logged
    /// by [`SystemdNotifier::describe`] once tracing is up.
    rejected: Vec<String>,
}

impl SystemdNotifier {
    /// Capture the service-manager settings of this process.
    ///
    /// Call once, from `main`, before any thread is spawned. The values are
    /// systemd's own protocol variables for a `Type=notify` unit
    /// (`sd_notify(3)`, `sd_watchdog_enabled(3)`); they select no path the
    /// agent writes, no credential and no mode. A unit or drop-in that points
    /// them elsewhere only diverts the agent's readiness and watchdog
    /// datagrams away from systemd, which then fails the unit (start timeout,
    /// watchdog) — the failure is loud, never silent.
    pub fn from_env() -> Self {
        let socket = std::env::var_os("NOTIFY_SOCKET");
        let usec = std::env::var_os("WATCHDOG_USEC");
        let pid = std::env::var_os("WATCHDOG_PID");
        Self::from_values(
            socket.as_ref().map(|s| s.to_string_lossy().into_owned()),
            usec.as_ref().map(|s| s.to_string_lossy().into_owned()),
            pid.as_ref().map(|s| s.to_string_lossy().into_owned()),
            std::process::id(),
        )
    }

    /// Parse the three protocol variables (pure; unit-tested).
    fn from_values(
        socket: Option<String>,
        watchdog_usec: Option<String>,
        watchdog_pid: Option<String>,
        own_pid: u32,
    ) -> Self {
        let mut rejected = Vec::new();
        let address = match socket {
            None => None,
            Some(s) if s.is_empty() => None,
            Some(s) => {
                if let Some(name) = s.strip_prefix('@') {
                    Some(NotifyAddress::Abstract(name.as_bytes().to_vec()))
                } else if s.starts_with('/') {
                    Some(NotifyAddress::Path(PathBuf::from(s)))
                } else {
                    rejected.push(format!(
                        "NOTIFY_SOCKET={s:?} is neither an absolute path nor an abstract \
                         (@) name; not notifying"
                    ));
                    None
                }
            }
        };
        // sd_watchdog_enabled(3): WATCHDOG_USEC is the timeout; when
        // WATCHDOG_PID is set it must name this process.
        let watchdog = match watchdog_usec {
            None => None,
            Some(raw) => match raw.trim().parse::<u64>() {
                Ok(0) => None,
                Ok(usec) => {
                    let for_us = match watchdog_pid.as_deref().map(str::trim) {
                        None | Some("") => true,
                        Some(p) => p.parse::<u32>().is_ok_and(|p| p == own_pid),
                    };
                    if for_us {
                        Some(Duration::from_micros(usec))
                    } else {
                        rejected.push(format!(
                            "WATCHDOG_PID={:?} does not name this process ({own_pid}); \
                             watchdog not armed",
                            watchdog_pid.unwrap_or_default()
                        ));
                        None
                    }
                }
                Err(_) => {
                    rejected.push(format!("WATCHDOG_USEC={raw:?} is not a number"));
                    None
                }
            },
        };
        Self {
            address,
            watchdog,
            rejected,
        }
    }

    /// A notifier that sends to `path` (tests).
    #[cfg(test)]
    pub fn for_socket(path: PathBuf, watchdog: Option<Duration>) -> Self {
        Self {
            address: Some(NotifyAddress::Path(path)),
            watchdog,
            rejected: Vec::new(),
        }
    }

    /// The configured `WatchdogSec`, when systemd armed a watchdog for this
    /// process.
    pub fn watchdog_timeout(&self) -> Option<Duration> {
        self.watchdog
    }

    /// One line for the boot log, plus every rejected setting.
    pub fn describe(&self) -> Vec<String> {
        let mut lines = vec![format!(
            "systemd notify: socket={}, watchdog={}",
            match &self.address {
                None => "none (not started by systemd)".to_string(),
                Some(NotifyAddress::Path(p)) => p.display().to_string(),
                Some(NotifyAddress::Abstract(n)) => format!("@{}", String::from_utf8_lossy(n)),
            },
            match self.watchdog {
                None => "off".to_string(),
                Some(d) => format!("{}ms", d.as_millis()),
            }
        )];
        lines.extend(self.rejected.iter().cloned());
        lines
    }

    /// `READY=1` with the status line: outputs are safe and the local control
    /// loop runs (DEC-6.2). Sent once per run.
    pub fn ready(&self, status: &str) -> io::Result<()> {
        self.send(&format!("READY=1\nSTATUS={}\n", one_line(status)))
    }

    /// `EXTEND_TIMEOUT_USEC=` with the status line, while the agent is still
    /// starting: it waits, with no output touched, for a configuration it may
    /// act on (ADR-048 DEC-4.10 standby). systemd extends the start timeout by
    /// `by` from now; the watchdog is not armed before READY, and READY is
    /// sent only once the outputs are safe (DEC-6.2), so a standby neither
    /// times out into a restart loop nor claims readiness.
    pub fn extend_start_timeout(&self, by: Duration, status: &str) -> io::Result<()> {
        self.send(&format!(
            "EXTEND_TIMEOUT_USEC={}\nSTATUS={}\n",
            by.as_micros(),
            one_line(status)
        ))
    }

    /// `STATUS=` only.
    pub fn status(&self, status: &str) -> io::Result<()> {
        self.send(&format!("STATUS={}\n", one_line(status)))
    }

    /// `WATCHDOG=1`. Only the liveness supervisor calls this, and only while
    /// every control loop has a fresh tick (DEC-6.4).
    pub fn watchdog_ping(&self) -> io::Result<()> {
        self.send("WATCHDOG=1\n")
    }

    /// `STOPPING=1` at the start of the shutdown sequence.
    pub fn stopping(&self, status: &str) -> io::Result<()> {
        self.send(&format!("STOPPING=1\nSTATUS={}\n", one_line(status)))
    }

    fn send(&self, message: &str) -> io::Result<()> {
        let Some(address) = &self.address else {
            return Ok(());
        };
        send_datagram(address, message.as_bytes())
    }
}

/// systemd parses one assignment per line; a status must not inject more.
fn one_line(status: &str) -> String {
    status
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect()
}

#[cfg(unix)]
fn send_datagram(address: &NotifyAddress, payload: &[u8]) -> io::Result<()> {
    use std::os::unix::net::UnixDatagram;
    let socket = UnixDatagram::unbound()?;
    let sent = match address {
        NotifyAddress::Path(path) => socket.send_to(payload, path)?,
        NotifyAddress::Abstract(name) => send_abstract(&socket, name, payload)?,
    };
    if sent == payload.len() {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::WriteZero,
            "incomplete sd_notify datagram",
        ))
    }
}

#[cfg(target_os = "linux")]
fn send_abstract(
    socket: &std::os::unix::net::UnixDatagram,
    name: &[u8],
    payload: &[u8],
) -> io::Result<usize> {
    use std::os::linux::net::SocketAddrExt;
    let addr = std::os::unix::net::SocketAddr::from_abstract_name(name)?;
    socket.send_to_addr(payload, &addr)
}

#[cfg(all(unix, not(target_os = "linux")))]
fn send_abstract(
    _socket: &std::os::unix::net::UnixDatagram,
    _name: &[u8],
    _payload: &[u8],
) -> io::Result<usize> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "abstract notify sockets exist only on Linux",
    ))
}

#[cfg(not(unix))]
fn send_datagram(_address: &NotifyAddress, _payload: &[u8]) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "sd_notify needs Unix datagram sockets",
    ))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixDatagram;

    fn recv(socket: &UnixDatagram) -> String {
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("timeout");
        let mut buf = [0u8; 512];
        let n = socket.recv(&mut buf).expect("datagram");
        String::from_utf8(buf[..n].to_vec()).expect("utf8")
    }

    #[test]
    fn ready_then_repeated_watchdog_reach_the_same_socket() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("notify.sock");
        let socket = UnixDatagram::bind(&path).expect("bind");
        let n = SystemdNotifier::for_socket(path, Some(Duration::from_secs(60)));
        n.ready("running: 2/2 outputs safe").expect("ready");
        assert_eq!(recv(&socket), "READY=1\nSTATUS=running: 2/2 outputs safe\n");
        // The regression this module exists for: the socket survives READY.
        for _ in 0..3 {
            n.watchdog_ping().expect("ping");
            assert_eq!(recv(&socket), "WATCHDOG=1\n");
        }
        n.stopping("stopping").expect("stopping");
        assert_eq!(recv(&socket), "STOPPING=1\nSTATUS=stopping\n");
    }

    #[test]
    fn standby_extends_the_start_timeout_without_ready() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("notify.sock");
        let socket = UnixDatagram::bind(&path).expect("bind");
        let n = SystemdNotifier::for_socket(path, Some(Duration::from_secs(60)));
        n.extend_start_timeout(Duration::from_secs(90), "standby: config\nREADY=1")
            .expect("extend");
        assert_eq!(
            recv(&socket),
            "EXTEND_TIMEOUT_USEC=90000000\nSTATUS=standby: config READY=1\n"
        );
    }

    #[test]
    fn status_cannot_inject_assignments() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("notify.sock");
        let socket = UnixDatagram::bind(&path).expect("bind");
        let n = SystemdNotifier::for_socket(path, None);
        n.status("degraded\nWATCHDOG=1").expect("status");
        assert_eq!(recv(&socket), "STATUS=degraded WATCHDOG=1\n");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn abstract_socket_is_supported() {
        use std::os::linux::net::SocketAddrExt;
        let name = format!("suderra-notify-test-{}", std::process::id());
        let addr = std::os::unix::net::SocketAddr::from_abstract_name(name.as_bytes()).unwrap();
        let socket = UnixDatagram::bind_addr(&addr).expect("bind abstract");
        let n = SystemdNotifier::from_values(Some(format!("@{name}")), None, None, 1);
        n.watchdog_ping().expect("ping");
        assert_eq!(recv(&socket), "WATCHDOG=1\n");
    }

    #[test]
    fn no_socket_means_not_under_systemd_and_sends_nothing() {
        let n = SystemdNotifier::from_values(None, None, None, 1);
        assert!(n.ready("x").is_ok());
        assert!(n.watchdog_timeout().is_none());
    }

    #[test]
    fn watchdog_follows_sd_watchdog_enabled() {
        let pid = 4242;
        let on = SystemdNotifier::from_values(
            Some("/run/systemd/notify".into()),
            Some("60000000".into()),
            Some(pid.to_string()),
            pid,
        );
        assert_eq!(on.watchdog_timeout(), Some(Duration::from_secs(60)));
        // No WATCHDOG_PID: the setting is for this process.
        let unpinned = SystemdNotifier::from_values(None, Some("2000000".into()), None, pid);
        assert_eq!(unpinned.watchdog_timeout(), Some(Duration::from_secs(2)));
        // Another process's watchdog is not ours.
        let other =
            SystemdNotifier::from_values(None, Some("60000000".into()), Some("1".into()), pid);
        assert!(other.watchdog_timeout().is_none());
        assert_eq!(other.describe().len(), 2);
        // 0 and garbage disarm it.
        assert!(
            SystemdNotifier::from_values(None, Some("0".into()), None, pid)
                .watchdog_timeout()
                .is_none()
        );
        assert!(
            SystemdNotifier::from_values(None, Some("sixty".into()), None, pid)
                .watchdog_timeout()
                .is_none()
        );
    }

    #[test]
    fn relative_socket_is_rejected() {
        let n = SystemdNotifier::from_values(Some("notify.sock".into()), None, None, 1);
        assert!(n.address.is_none());
        assert_eq!(n.describe().len(), 2);
    }
}
