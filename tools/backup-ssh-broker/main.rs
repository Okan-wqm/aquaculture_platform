#![forbid(unsafe_code)]

use std::env;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::FileTypeExt;
use std::path::Path;
use std::process::{self, Command};

const PROC_STATUS_PATH: &str = "/proc/self/status";
const PROC_STDIN_PATH: &str = "/proc/self/fd/0";
const PASSWD_PATH: &str = "/etc/passwd";
const SHA256SUM_PATH: &str = "/usr/bin/sha256sum";
const BROKER_INSTALL_PATH: &str = "/usr/local/sbin/aqua-protected-ssh-broker";
const BROKER_HOME_ROOT: &str = "/var/lib/aqua-protected-ssh";
const ATTESTATION_PROTOCOL: &str = "aqua-protected-ssh-attestation-v1";
const BROKER_SOURCE_SHA256: &str = env!("AQUA_BROKER_SOURCE_SHA256");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Route {
    user: &'static str,
    token: &'static str,
    operation: &'static str,
}

const ROUTES: [Route; 3] = [
    Route {
        user: "aqua-backup",
        token: "aqua-backup-v1",
        operation: "backup",
    },
    Route {
        user: "aqua-pitr",
        token: "aqua-pitr-v1",
        operation: "pitr",
    },
    Route {
        user: "aqua-wal-freshness",
        token: "aqua-wal-freshness-v1",
        operation: "archive-freshness",
    },
];

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProcessCredentials {
    uids: [u32; 4],
    gids: [u32; 4],
    groups: Vec<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PasswdIdentity<'a> {
    username: &'a str,
    gid: u32,
    home: &'a str,
    shell: &'a str,
}

fn parse_login_invocation(arguments: &[OsString]) -> Result<&OsStr, &'static str> {
    if arguments.len() != 3 {
        return Err("broker invocation must contain exactly two arguments");
    }
    if arguments[1] != OsStr::new("-c") {
        return Err("broker accepts only login-shell -c mode");
    }
    Ok(arguments[2].as_os_str())
}

fn login_route(user: &str, token: &OsStr) -> Option<&'static Route> {
    ROUTES
        .iter()
        .find(|route| route.user == user && token == OsStr::new(route.token))
}

fn parse_four_ids(fields: &str) -> Result<[u32; 4], &'static str> {
    let values: Vec<&str> = fields.split_whitespace().collect();
    if values.len() != 4 {
        return Err("process credential record is malformed");
    }

    let mut parsed = [0_u32; 4];
    for (index, value) in values.iter().enumerate() {
        parsed[index] = value
            .parse::<u32>()
            .map_err(|_| "process credential value is malformed")?;
    }
    Ok(parsed)
}

fn parse_status_credentials(status: &str) -> Result<ProcessCredentials, &'static str> {
    let mut uids = None;
    let mut gids = None;
    let mut groups = None;

    for line in status.lines() {
        if let Some(fields) = line.strip_prefix("Uid:") {
            if uids.is_some() {
                return Err("process status contains duplicate Uid records");
            }
            uids = Some(parse_four_ids(fields)?);
        } else if let Some(fields) = line.strip_prefix("Gid:") {
            if gids.is_some() {
                return Err("process status contains duplicate Gid records");
            }
            gids = Some(parse_four_ids(fields)?);
        } else if let Some(fields) = line.strip_prefix("Groups:") {
            if groups.is_some() {
                return Err("process status contains duplicate Groups records");
            }
            let parsed_groups = fields
                .split_whitespace()
                .map(|value| {
                    value
                        .parse::<u32>()
                        .map_err(|_| "process group value is malformed")
                })
                .collect::<Result<Vec<u32>, &'static str>>()?;
            groups = Some(parsed_groups);
        }
    }

    Ok(ProcessCredentials {
        uids: uids.ok_or("process status does not contain a Uid record")?,
        gids: gids.ok_or("process status does not contain a Gid record")?,
        groups: groups.ok_or("process status does not contain a Groups record")?,
    })
}

fn validate_process_credentials(credentials: &ProcessCredentials) -> Result<(), &'static str> {
    if credentials.uids[0] == 0
        || credentials
            .uids
            .iter()
            .any(|uid| *uid != credentials.uids[0])
    {
        return Err("login-shell uid boundary is invalid");
    }
    if credentials.gids[0] == 0
        || credentials
            .gids
            .iter()
            .any(|gid| *gid != credentials.gids[0])
        || credentials.groups.as_slice() != [credentials.gids[0]]
    {
        return Err("login-shell gid boundary is invalid");
    }
    Ok(())
}

fn identity_for_uid(passwd: &str, uid: u32) -> Result<PasswdIdentity<'_>, &'static str> {
    let mut matched_identity = None;

    for line in passwd.lines() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let fields: Vec<&str> = line.split(':').collect();
        if fields.len() != 7 || fields[0].is_empty() {
            return Err("passwd record is malformed");
        }
        let record_uid = fields[2]
            .parse::<u32>()
            .map_err(|_| "passwd uid is malformed")?;
        if record_uid != uid {
            continue;
        }
        if matched_identity.is_some() {
            return Err("passwd contains duplicate records for the process uid");
        }
        let gid = fields[3]
            .parse::<u32>()
            .map_err(|_| "passwd gid is malformed")?;
        matched_identity = Some(PasswdIdentity {
            username: fields[0],
            gid,
            home: fields[5],
            shell: fields[6],
        });
    }

    matched_identity.ok_or("process uid has no direct passwd record")
}

fn path_looks_like_tty(target: &Path) -> bool {
    let rendered = target.as_os_str().to_string_lossy();
    rendered == "/dev/console"
        || rendered == "/dev/tty"
        || rendered.starts_with("/dev/tty")
        || rendered.starts_with("/dev/pts/")
        || rendered.starts_with("/dev/pty")
}

fn is_lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn attestation_line(
    route: &Route,
    source_sha256: &str,
    binary_sha256: &str,
) -> Result<String, &'static str> {
    if !is_lowercase_sha256(source_sha256) || !is_lowercase_sha256(binary_sha256) {
        return Err("broker attestation sha256 is invalid");
    }
    Ok(format!(
        "{{\"protocol\":\"{ATTESTATION_PROTOCOL}\",\"account\":\"{}\",\"operation\":\"{}\",\"token\":\"{}\",\"source_sha256\":\"{source_sha256}\",\"binary_sha256\":\"{binary_sha256}\"}}",
        route.user, route.operation, route.token
    ))
}

fn running_binary_sha256() -> Result<String, String> {
    let executable_path = format!("/proc/{}/exe", process::id());
    let output = Command::new(SHA256SUM_PATH)
        .args(["--binary", executable_path.as_str()])
        .env_clear()
        .env("LC_ALL", "C")
        .output()
        .map_err(|error| format!("cannot execute the binary sha256 authority: {error}"))?;
    if !output.status.success() || !output.stderr.is_empty() {
        return Err("binary sha256 authority failed".to_owned());
    }

    let stdout = String::from_utf8(output.stdout)
        .map_err(|_| "binary sha256 authority returned non-UTF-8 output".to_owned())?;
    let line = stdout
        .strip_suffix('\n')
        .ok_or_else(|| "binary sha256 authority omitted its final newline".to_owned())?;
    if line.contains('\n') || line.contains('\r') {
        return Err("binary sha256 authority returned multiple lines".to_owned());
    }
    let expected_suffix = format!(" *{executable_path}");
    let digest = line
        .strip_suffix(&expected_suffix)
        .ok_or_else(|| "binary sha256 authority returned an unexpected path".to_owned())?;
    if !is_lowercase_sha256(digest) {
        return Err("binary sha256 authority returned an invalid digest".to_owned());
    }
    Ok(digest.to_owned())
}

fn current_credentials() -> Result<ProcessCredentials, String> {
    let status = fs::read_to_string(PROC_STATUS_PATH)
        .map_err(|error| format!("cannot read Linux process status: {error}"))?;
    parse_status_credentials(&status).map_err(str::to_owned)
}

fn reject_tty_stdin() -> Result<(), String> {
    let target = fs::read_link(PROC_STDIN_PATH)
        .map_err(|error| format!("cannot inspect standard input: {error}"))?;
    let metadata = fs::metadata(PROC_STDIN_PATH)
        .map_err(|error| format!("cannot inspect standard input type: {error}"))?;

    if metadata.file_type().is_char_device() || path_looks_like_tty(&target) {
        return Err("terminal-backed standard input is forbidden".to_owned());
    }
    Ok(())
}

fn run() -> Result<(), String> {
    let arguments: Vec<OsString> = env::args_os().collect();
    let token = parse_login_invocation(&arguments).map_err(str::to_owned)?;

    let credentials = current_credentials()?;
    validate_process_credentials(&credentials).map_err(str::to_owned)?;

    let passwd = fs::read_to_string(PASSWD_PATH)
        .map_err(|error| format!("cannot read the local passwd authority: {error}"))?;
    let identity = identity_for_uid(&passwd, credentials.uids[0]).map_err(str::to_owned)?;
    let route = login_route(identity.username, token).ok_or_else(|| {
        "login account and fixed command do not map to an allowed operation".to_owned()
    })?;
    let expected_home = format!("{BROKER_HOME_ROOT}/{}", route.user);
    if identity.gid != credentials.gids[0]
        || identity.home != expected_home
        || identity.shell != BROKER_INSTALL_PATH
    {
        return Err("login account record does not match the protected boundary".to_owned());
    }

    let original_command = env::var_os("SSH_ORIGINAL_COMMAND")
        .ok_or_else(|| "SSH_ORIGINAL_COMMAND is required".to_owned())?;
    if original_command != OsStr::new(route.token) {
        return Err("SSH_ORIGINAL_COMMAND does not match the fixed command".to_owned());
    }
    reject_tty_stdin()?;

    let binary_sha256 = running_binary_sha256()?;
    let attestation =
        attestation_line(route, BROKER_SOURCE_SHA256, &binary_sha256).map_err(str::to_owned)?;
    let stdout = io::stdout();
    let mut output = stdout.lock();
    writeln!(output, "{attestation}")
        .and_then(|()| output.flush())
        .map_err(|error| format!("cannot write the broker attestation: {error}"))
}

fn main() {
    if let Err(error) = run() {
        eprintln!("FATAL: {error}");
        process::exit(2);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn parses_only_exact_login_shell_argv() {
        let login = argv(&["broker", "-c", "aqua-backup-v1"]);
        assert_eq!(
            parse_login_invocation(&login),
            Ok(OsStr::new("aqua-backup-v1"))
        );

        assert!(parse_login_invocation(&argv(&["broker", "aqua-backup-v1"])).is_err());
        assert!(parse_login_invocation(&argv(&["broker", "-c"])).is_err());
        assert!(
            parse_login_invocation(&argv(&["broker", "-c", "aqua-backup-v1", "extra"])).is_err()
        );
        assert!(parse_login_invocation(&argv(&["broker", "--execute", "backup"])).is_err());
    }

    #[test]
    fn maps_each_login_account_to_exactly_one_token_and_operation() {
        for route in ROUTES {
            assert_eq!(
                login_route(route.user, OsStr::new(route.token)),
                Some(&route)
            );
        }

        assert!(login_route("aqua-backup", OsStr::new("aqua-pitr-v1")).is_none());
        assert!(login_route("root", OsStr::new("aqua-backup-v1")).is_none());
        assert!(login_route("aqua-backup ", OsStr::new("aqua-backup-v1")).is_none());
    }

    #[test]
    fn renders_one_exact_attestation_shape_for_every_route() {
        let source_sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let binary_sha = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
        for route in ROUTES {
            assert_eq!(
                attestation_line(&route, source_sha, binary_sha),
                Ok(format!(
                    "{{\"protocol\":\"aqua-protected-ssh-attestation-v1\",\"account\":\"{}\",\"operation\":\"{}\",\"token\":\"{}\",\"source_sha256\":\"{source_sha}\",\"binary_sha256\":\"{binary_sha}\"}}",
                    route.user, route.operation, route.token
                ))
            );
        }
        assert!(attestation_line(&ROUTES[0], "ABC", binary_sha).is_err());
        assert!(attestation_line(&ROUTES[0], source_sha, "ABC").is_err());
    }

    #[test]
    fn build_injects_source_sha_and_runtime_hashes_the_broker_pid_executable() {
        assert!(is_lowercase_sha256(BROKER_SOURCE_SHA256));
        let binary_sha = running_binary_sha256().expect("test broker binary must be hashable");
        assert!(is_lowercase_sha256(&binary_sha));
    }

    #[test]
    fn parses_and_validates_the_complete_linux_credential_boundary() {
        let status = concat!(
            "Name:\tbroker\n",
            "Uid:\t1001\t1001\t1001\t1001\n",
            "Gid:\t1002\t1002\t1002\t1002\n",
            "Groups:\t1002 \n",
        );
        let expected = ProcessCredentials {
            uids: [1001, 1001, 1001, 1001],
            gids: [1002, 1002, 1002, 1002],
            groups: vec![1002],
        };
        assert_eq!(parse_status_credentials(status), Ok(expected.clone()));
        assert_eq!(validate_process_credentials(&expected), Ok(()));

        assert!(parse_status_credentials("Name:\tbroker\n").is_err());
        assert!(parse_status_credentials("Uid:\t1001\t1001\n").is_err());
        assert!(
            parse_status_credentials(concat!(
                "Uid:\t1001\t1001\t1001\t1001\n",
                "Uid:\t1001\t1001\t1001\t1001\n",
                "Gid:\t1002\t1002\t1002\t1002\n",
                "Groups:\t1002\n",
            ))
            .is_err()
        );

        for rejected in [
            ProcessCredentials {
                uids: [0, 0, 0, 0],
                ..expected.clone()
            },
            ProcessCredentials {
                uids: [1001, 1001, 1001, 0],
                ..expected.clone()
            },
            ProcessCredentials {
                gids: [1002, 1002, 0, 1002],
                ..expected.clone()
            },
            ProcessCredentials {
                groups: vec![1002, 999],
                ..expected.clone()
            },
        ] {
            assert!(validate_process_credentials(&rejected).is_err());
        }
    }

    #[test]
    fn resolves_a_uid_only_when_passwd_has_one_direct_exact_record() {
        let passwd = concat!(
            "root:x:0:0:root:/root:/bin/bash\n",
            "aqua-backup:x:991:991::/var/lib/aqua-protected-ssh/aqua-backup:/usr/local/sbin/aqua-protected-ssh-broker\n",
            "aqua-pitr:x:992:992::/var/lib/aqua-protected-ssh/aqua-pitr:/usr/local/sbin/aqua-protected-ssh-broker\n",
        );
        assert_eq!(
            identity_for_uid(passwd, 991),
            Ok(PasswdIdentity {
                username: "aqua-backup",
                gid: 991,
                home: "/var/lib/aqua-protected-ssh/aqua-backup",
                shell: "/usr/local/sbin/aqua-protected-ssh-broker",
            })
        );
        assert!(identity_for_uid(passwd, 999).is_err());

        let duplicate_uid = concat!(
            "aqua-backup:x:991:991::/nonexistent:/usr/local/sbin/aqua-protected-ssh-broker\n",
            "alias:x:991:991::/nonexistent:/usr/sbin/nologin\n",
        );
        assert!(identity_for_uid(duplicate_uid, 991).is_err());
        assert!(identity_for_uid("malformed\n", 991).is_err());
    }

    #[test]
    fn recognizes_linux_terminal_device_paths() {
        assert!(path_looks_like_tty(Path::new("/dev/pts/4")));
        assert!(path_looks_like_tty(Path::new("/dev/tty")));
        assert!(path_looks_like_tty(Path::new("/dev/console")));
        assert!(!path_looks_like_tty(Path::new("pipe:[1234]")));
        assert!(!path_looks_like_tty(Path::new("/tmp/payload")));
    }
}
