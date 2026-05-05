# CLI Command Reference — `suderra-agent`

**Binary:** `suderra-agent` (`Cargo.toml:447-449`).
**Arg parser:** hand-rolled (no `clap` dependency — `Cargo.toml` contains no `clap` / `structopt` / `argh`). Parsing is a direct `match` on `std::env::args().collect::<Vec<String>>().get(1)` (`src/main.rs:425-468`).
**Parsing scope:** first positional argument only — subsequent args produce `Unknown argument: ...` and exit 1 (`src/main.rs:461-466`).

## Complete flag set

Evidence: `src/main.rs:429-466`.

| Flag | Aliases | Behaviour | Exit code |
|---|---|---|---|
| `--init` | — | Generate default config at `/etc/suderra/config.yaml` (or `$SUDERRA_CONFIG` path, see `src/main.rs:142-175`) | 0 on success, 1 on I/O error |
| `--version` | `-V` | Print `Suderra Edge Agent v{CARGO_PKG_VERSION}` and exit | 0 |
| `--help` | `-h` | Print help text, USAGE, OPTIONS, ENVIRONMENT, and exit | 0 |
| *(no arg)* | — | Start the agent (default behaviour) | 0 on clean shutdown; 1 on fatal init error |

## Help output (verbatim from `src/main.rs:443-459`)

```
Suderra Edge Agent v1.6.0

USAGE:
    suderra-agent [OPTIONS]

OPTIONS:
    --init       Generate default configuration file
    --version    Print version information
    --help       Print this help message

ENVIRONMENT:
    SUDERRA_CONFIG    Path to config file (default: /etc/suderra/config.yaml)
    RUST_LOG          Log level filter (e.g., debug, info, warn)
```

## Environment variables

Evidence: `grep -n "env::var\|SUDERRA_" src/main.rs src/config.rs`.

| Variable | Default | Consumer | Purpose |
|---|---|---|---|
| `SUDERRA_CONFIG` | `/etc/suderra/config.yaml` (`src/config.rs:141`) | `AgentConfig::load` (`src/config.rs:1336-1340`) + `generate_default_config` (`src/main.rs:147-156`) | Path to the YAML configuration file |
| `SUDERRA_DATA_DIR` | `/var/lib/suderra` (`src/main.rs:1171, 1297-1306`) | `data_dir` resolution for SQLite + offline-queue + LoRa session DB | Runtime state directory |
| `RUST_LOG` | (unset → `info` default via `tracing-subscriber::EnvFilter`) | `tracing-subscriber` layer init in `init_logging()` (`src/main.rs:504-505` calls `init_logging()`) | Log level filter per-module |

## Signals

Evidence: `src/shutdown.rs` + `src/main.rs` SIGHUP handler.

| Signal | Behaviour |
|---|---|
| `SIGTERM` / `SIGINT` | Graceful shutdown via `ShutdownCoordinator` — drain, publish Offline status, disconnect MQTT, flush SQLite, abort task handles (`src/mqtt.rs:666-684`) |
| `SIGHUP` | Re-read `$SUDERRA_CONFIG` (`src/main.rs:727`) — config hot-reload without restart |
| `SIGKILL` | Uncatchable — systemd unit wraps in `Restart=on-failure` with `RestartSec=5s` (see `systemd/` unit file) |

## systemd integration

Evidence: `Cargo.toml:100-101` (`sd-notify = "0.4"`) + `src/main.rs` watchdog calls.

The agent sends `sd_notify` messages at the following lifecycle events:
- `READY=1` after config loaded + provisioning verified (systemd Type=notify)
- `WATCHDOG=1` periodically — integrates with `WatchdogSec=` in the unit file to trigger restart if the main loop stalls
- `STOPPING=1` on SIGTERM receipt

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Clean shutdown (SIGTERM received, ShutdownCoordinator completed) |
| 1 | Fatal init error (config load, provisioning, MQTT bootstrap failure) |
| 1 | Unknown CLI argument (`src/main.rs:461-466`) |

## Differences vs conventional CLI tools

- No subcommand hierarchy. `suderra-agent` is a daemon — it has exactly one operating mode (run) and three one-shot modes (`--init`, `--version`, `--help`).
- No `--config <path>` flag. Config path is sourced from `$SUDERRA_CONFIG` only. Reasoning: the binary is invoked by systemd with a pinned environment; runtime path override is not a supported operator workflow.
- No `--dry-run` / `--validate-config` flag. Config validation happens at `AgentConfig::load` → `validate()` (`src/config.rs:1364-1725`); a dedicated validate flag is NOT YET WIRED — tracked under `orphan-findings.md` hygiene items, no owner assigned today.

## OpenCLI / machine schema

No upstream machine-schema for CLI exists today. When the command surface grows beyond 3 flags, a migration to `clap = "4"` with `#[derive(Parser)]` is the conventional path; the `--help` output then becomes derivable from struct attributes and a machine schema can be emitted via `clap_complete`. No owner + deadline assigned today.
