#!/usr/bin/env python3
"""ARIA Phase-1 PoC — operator decision tool.

Pure-mechanical analysis of the repository. No LLM calls. No external network.
Generates a decision-gate report at .aria-poc/aria-poc-report.md.

Spec: docs/aria/CONTRACTS.md §13
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import os
import re
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

EXCLUDED_DIRS: set[str] = {
    "agent-workspace", "node_modules", ".git", "dist", "build",
    "coverage", ".next", ".nx", "target", "tmp", "out-tsc",
    ".aria-poc", ".turbo", ".cache",
}

LANGUAGE_BY_EXT: dict[str, str] = {
    ".ts": "typescript", ".tsx": "typescript",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript",
    ".rs": "rust", ".py": "python",
    ".sql": "sql", ".md": "markdown",
    ".yaml": "yaml", ".yml": "yaml",
    ".json": "json", ".toml": "toml",
    ".sh": "shell", ".html": "html", ".css": "css", ".scss": "scss",
}

MANIFEST_FILES: set[str] = {
    "package.json", "Cargo.toml", "project.json", "nx.json",
    "docker-compose.yml", "docker-compose.yaml",
    "tsconfig.json", "Dockerfile",
}

TS_ENUM_PATTERN = re.compile(
    r"(?:export\s+)?enum\s+(\w+)\s*\{([^}]+)\}",
    re.MULTILINE | re.DOTALL,
)
SQL_ENUM_PATTERN = re.compile(
    r"CREATE\s+TYPE\s+(\w+)\s+AS\s+ENUM\s*\(([^)]+)\)",
    re.IGNORECASE | re.DOTALL,
)


@dataclasses.dataclass
class Fingerprint:
    repo_root: str
    captured_at: str
    file_count: int
    language_histogram: dict[str, int]
    manifests_found: list[str]
    apps_count: int
    web_modules_count: int
    migration_count: int
    has_claude_md: bool
    canonical_adr_count: int
    specialized_agent_count: int
    nx_graph_available: bool


@dataclasses.dataclass
class FileFate:
    path: str
    fate: str  # read_deeply | read_skimmed | skipped_with_reason
    reason: str = ""


def walk_repo(repo_root: Path) -> list[Path]:
    out: list[Path] = []
    for root, dirs, files in os.walk(repo_root):
        dirs[:] = [d for d in dirs if d not in EXCLUDED_DIRS and not d.startswith(".git")]
        rp = Path(root)
        for f in files:
            out.append(rp / f)
    return out


def git_ls_files(repo_root: Path) -> set[str]:
    try:
        r = subprocess.run(
            ["git", "-C", str(repo_root), "ls-files"],
            capture_output=True, text=True, check=True, timeout=60,
        )
        return set(r.stdout.strip().splitlines())
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        return set()


def assign_fate(path: Path, repo_root: Path) -> FileFate:
    rel = str(path.relative_to(repo_root))
    ext = path.suffix.lower()
    name = path.name
    if name in MANIFEST_FILES or ext in LANGUAGE_BY_EXT:
        return FileFate(rel, "read_deeply")
    if ext in {".lock", ".log", ".map", ".png", ".jpg", ".svg", ".ico", ".pdf"}:
        return FileFate(rel, "skipped_with_reason", "binary/generated/asset")
    return FileFate(rel, "read_skimmed", "no specialized adapter")


def compute_fingerprint(repo_root: Path, fates: list[FileFate]) -> Fingerprint:
    lang_hist: Counter[str] = Counter()
    manifests: set[str] = set()
    for fate in fates:
        if fate.fate == "skipped_with_reason":
            continue
        p = Path(fate.path)
        ext = p.suffix.lower()
        if ext in LANGUAGE_BY_EXT:
            lang_hist[LANGUAGE_BY_EXT[ext]] += 1
        if p.name in MANIFEST_FILES:
            manifests.add(p.name)

    apps_dir = repo_root / "apps"
    apps_count = sum(1 for p in apps_dir.iterdir() if p.is_dir()) if apps_dir.exists() else 0
    web_modules_dir = repo_root / "web" / "modules"
    web_modules_count = (
        sum(1 for p in web_modules_dir.iterdir() if p.is_dir()) if web_modules_dir.exists() else 0
    )
    migration_count = sum(
        1 for f in fates if "/database/migrations/" in f.path and f.path.endswith(".ts")
    )
    adr_dir = repo_root / "docs" / "adr"
    canonical_adr_count = (
        sum(1 for _ in adr_dir.glob("[0-9][0-9][0-9]-*.md")) if adr_dir.exists() else 0
    )
    agents_dir = repo_root / ".claude" / "agents"
    specialized_agent_count = 0
    if agents_dir.exists():
        specialized_agent_count = sum(
            1 for p in agents_dir.iterdir()
            if p.is_file() and p.suffix == ".md"
            and not p.name.startswith("_") and p.name != "README.md"
        )

    return Fingerprint(
        repo_root=str(repo_root),
        captured_at=datetime.now(timezone.utc).isoformat(),
        file_count=sum(1 for f in fates if f.fate != "skipped_with_reason"),
        language_histogram=dict(lang_hist),
        manifests_found=sorted(manifests),
        apps_count=apps_count,
        web_modules_count=web_modules_count,
        migration_count=migration_count,
        has_claude_md=(repo_root / "CLAUDE.md").exists(),
        canonical_adr_count=canonical_adr_count,
        specialized_agent_count=specialized_agent_count,
        nx_graph_available=(repo_root / "nx.json").exists(),
    )


def write_claude_md_priors(repo_root: Path, out_dir: Path) -> Path | None:
    src = repo_root / "CLAUDE.md"
    if not src.exists():
        return None
    content = src.read_text(encoding="utf-8", errors="replace")
    headings = re.findall(r"^##+\s+(.+)$", content, re.MULTILINE)
    out = out_dir / "CLAUDE_MD_PRIORS.md"
    parts = [
        "# CLAUDE.md priors (mechanical extraction, no LLM)\n\n",
        f"_Source:_ `{src.relative_to(repo_root)}`  \n",
        f"_Captured:_ {datetime.now(timezone.utc).isoformat()}  \n",
        f"_SHA-256 (first 16):_ `{hashlib.sha256(content.encode()).hexdigest()[:16]}`\n\n",
        f"## Section headings ({len(headings)})\n\n",
    ]
    parts.extend(f"- {h.strip()}\n" for h in headings)
    out.write_text("".join(parts), encoding="utf-8")
    return out


def write_adr_priors(repo_root: Path, out_dir: Path) -> tuple[Path | None, int]:
    adr_dir = repo_root / "docs" / "adr"
    if not adr_dir.exists():
        return None, 0
    canonical = sorted(adr_dir.glob("[0-9][0-9][0-9]-*.md"))
    out = out_dir / "ADR_PRIORS.md"
    lines = ["# ADR priors (canonical, mechanical extraction)\n\n"]
    for f in canonical:
        text = f.read_text(encoding="utf-8", errors="replace")
        title_match = re.search(r"^#\s+(.+)$", text, re.MULTILINE)
        status_match = re.search(
            r"^\**\s*Status\s*:?\**\s*([A-Za-z][A-Za-z\- ]*)",
            text, re.MULTILINE | re.IGNORECASE,
        )
        title = title_match.group(1).strip() if title_match else f.stem
        status = status_match.group(1).strip() if status_match else "unknown"
        lines.append(f"- **{f.stem}** [{status}] — {title}\n")
    out.write_text("".join(lines), encoding="utf-8")
    return out, len(canonical)


def write_agent_priors(repo_root: Path, out_dir: Path) -> tuple[Path | None, int]:
    agents_dir = repo_root / ".claude" / "agents"
    if not agents_dir.exists():
        return None, 0
    files = sorted(
        f for f in agents_dir.iterdir()
        if f.is_file() and f.suffix == ".md"
        and not f.name.startswith("_") and f.name != "README.md"
    )
    out = out_dir / "AGENT_PRIORS.md"
    lines = ["# Specialized agent priors (.claude/agents/, mechanical extraction)\n\n"]
    try:
        import yaml  # noqa: F401
        have_yaml = True
    except ImportError:
        have_yaml = False
    for f in files:
        text = f.read_text(encoding="utf-8", errors="replace")
        fm_match = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
        desc = ""
        if fm_match and have_yaml:
            try:
                import yaml
                fm = yaml.safe_load(fm_match.group(1))
                if isinstance(fm, dict):
                    desc = str(fm.get("description", "") or "")
            except Exception:
                desc = ""
        if not desc:
            body = text[fm_match.end():].strip() if fm_match else text.strip()
            first_para = body.split("\n\n")[0].strip().replace("\n", " ")
            desc = first_para
        if len(desc) > 200:
            desc = desc[:197] + "..."
        lines.append(f"- **{f.stem}** — {desc}\n")
    out.write_text("".join(lines), encoding="utf-8")
    return out, len(files)


def run_nx_graph(repo_root: Path, out_dir: Path) -> bool:
    out_path = out_dir / "BUILD_GRAPH.json"
    try:
        r = subprocess.run(
            ["npx", "nx", "graph", f"--file={out_path}"],
            cwd=repo_root, capture_output=True, text=True, timeout=180,
        )
        return r.returncode == 0 and out_path.exists()
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False


def detect_ts_enums(repo_root: Path, fates: list[FileFate]) -> list[dict]:
    enums: list[dict] = []
    for f in fates:
        if not f.path.endswith((".ts", ".tsx")):
            continue
        if f.path.endswith(".d.ts") or "/__tests__/" in f.path:
            continue
        full = repo_root / f.path
        try:
            text = full.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for m in TS_ENUM_PATTERN.finditer(text):
            name = m.group(1)
            body = m.group(2)
            # Strip line + block comments BEFORE splitting on commas (Turkish
            # comments preceding values were being captured as part of values).
            body_clean = re.sub(r"//[^\n]*", "", body)
            body_clean = re.sub(r"/\*.*?\*/", "", body_clean, flags=re.DOTALL)
            values: list[str] = []
            for raw in body_clean.split(","):
                raw = raw.strip()
                if not raw:
                    continue
                key = raw.split("=")[0].strip().strip("'\"")
                if key and re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", key):
                    values.append(key)
            line = text[: m.start()].count("\n") + 1
            enums.append({
                "name": name,
                "values": sorted(set(values)),
                "ref": f"{f.path}:{line}",
            })
    return enums


def detect_sql_enums(repo_root: Path, fates: list[FileFate]) -> list[dict]:
    enums: list[dict] = []
    for f in fates:
        if "/database/migrations/" not in f.path:
            continue
        full = repo_root / f.path
        try:
            text = full.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for m in SQL_ENUM_PATTERN.finditer(text):
            name = m.group(1)
            body = m.group(2)
            values = [v.strip().strip("'\"") for v in body.split(",")]
            values = [v for v in values if v]
            line = text[: m.start()].count("\n") + 1
            enums.append({
                "name": name,
                "values": sorted(set(values)),
                "ref": f"{f.path}:{line}",
            })
    return enums


def find_drifts(ts_enums: list[dict], sql_enums: list[dict]) -> list[dict]:
    def norm(name: str) -> str:
        n = name.lower()
        for suffix in ("_enum", "enum", "_status", "status", "_type", "type"):
            if n.endswith(suffix) and len(n) > len(suffix):
                n = n[: -len(suffix)]
                break
        return n

    by_norm_ts: dict[str, list[dict]] = {}
    for e in ts_enums:
        by_norm_ts.setdefault(norm(e["name"]), []).append(e)

    drifts: list[dict] = []
    for sql in sql_enums:
        for ts in by_norm_ts.get(norm(sql["name"]), []):
            ts_vals = {v.lower() for v in ts["values"]}
            sql_vals = {v.lower() for v in sql["values"]}
            if ts_vals != sql_vals:
                drifts.append({
                    "concept": norm(sql["name"]),
                    "ts": ts,
                    "sql": sql,
                    "missing_in_ts": sorted(sql_vals - ts_vals),
                    "missing_in_sql": sorted(ts_vals - sql_vals),
                })
    return drifts


def write_report(out_dir: Path, fp: Fingerprint, fates: list[FileFate],
                 drifts: list[dict], artifacts: list[str]) -> Path:
    skipped = sum(1 for f in fates if f.fate == "skipped_with_reason")
    deeply = sum(1 for f in fates if f.fate == "read_deeply")
    skim = sum(1 for f in fates if f.fate == "read_skimmed")
    r: list[str] = []
    r.append("# ARIA Phase-1 PoC Report\n\n")
    r.append(f"**Captured:** {fp.captured_at}  \n")
    r.append(f"**Repo:** `{fp.repo_root}`  \n")
    r.append("**LLM calls:** 0  \n")
    r.append("**Network calls:** 0 (except optional `npx nx graph` subprocess)\n\n---\n\n")

    r.append("## 1. Coverage Invariant\n\n")
    r.append(f"- Files visited: {len(fates)}\n")
    r.append(f"  - read_deeply: {deeply}\n")
    r.append(f"  - read_skimmed: {skim}\n")
    r.append(f"  - skipped_with_reason: {skipped}\n")
    r.append(f"- Coverage Invariant: {'PASS' if len(fates) > 0 else 'FAIL'} (every file has a fate)\n\n")

    r.append("## 2. Repository Fingerprint\n\n")
    r.append(f"- `apps/*` count: {fp.apps_count}\n")
    r.append(f"- `web/modules/*` count: {fp.web_modules_count}\n")
    r.append(f"- TypeORM migrations: {fp.migration_count}\n")
    r.append(f"- CLAUDE.md present: {fp.has_claude_md}\n")
    r.append(f"- Canonical ADRs (`docs/adr/`): {fp.canonical_adr_count}\n")
    r.append(f"- Specialized agents (`.claude/agents/`): {fp.specialized_agent_count}\n")
    r.append(f"- Nx workspace: {fp.nx_graph_available}\n")
    if fp.manifests_found:
        r.append(f"- Manifests detected: `{', '.join(fp.manifests_found)}`\n\n")
    else:
        r.append("\n")
    r.append("### Language histogram (top 10 by file count)\n\n")
    top = sorted(fp.language_histogram.items(), key=lambda x: -x[1])[:10]
    for lang, n in top:
        r.append(f"- {lang}: {n}\n")
    r.append("\n")

    r.append("## 3. Trusted Priors Ingested\n\n")
    for art in artifacts:
        r.append(f"- `{art}`\n")
    r.append("\n")

    r.append("## 4. Mechanical Drift Scan (TS `enum` vs SQL `CREATE TYPE ... AS ENUM`)\n\n")
    if drifts:
        r.append(f"Found **{len(drifts)} drift candidate(s)**. Each requires manual verification.\n\n")
        for i, d in enumerate(drifts[:10], 1):
            r.append(f"### Drift {i}: `{d['concept']}`\n\n")
            r.append(f"- TS `{d['ts']['name']}` at `{d['ts']['ref']}` — values: `{d['ts']['values']}`\n")
            r.append(f"- SQL `{d['sql']['name']}` at `{d['sql']['ref']}` — values: `{d['sql']['values']}`\n")
            if d["missing_in_ts"]:
                r.append(f"- Missing in TS: `{d['missing_in_ts']}`\n")
            if d["missing_in_sql"]:
                r.append(f"- Missing in SQL: `{d['missing_in_sql']}`\n")
            r.append("\n")
    else:
        r.append("No drift candidates detected by mechanical scan.\n\n")
        r.append("**Absence claim discipline (per SPEC §7.2 Rule B):**\n")
        r.append("- Heuristic only matched TS `enum` keyword + SQL `CREATE TYPE ... AS ENUM`.\n")
        r.append("- Union types (`type FarmStatus = 'a' | 'b'`) NOT scanned.\n")
        r.append("- Frontend select/dropdown options NOT scanned.\n")
        r.append("- GraphQL/Zod schemas NOT scanned.\n")
        r.append("- Confidence cap on absence claim: 0.7.\n\n")

    r.append("## 5. Operator Decision Gate\n\n")
    r.append("Answer YES/NO to each (per CONTRACTS §13):\n\n")
    r.append("1. Did the fingerprint reveal anything you did not already know? `[ ]`\n")
    r.append("2. Did the mechanical drift scan surface real drift not caught by existing 38 specialized agents on PR cycles? `[ ]`\n")
    r.append("3. Is the value surface of (2) large enough to justify months of kernel work? `[ ]`\n")
    r.append("4. Is the LLM cost (Claude Code session-based, NOT direct API — see CONTRACTS §0.6) within scope? `[ ]`\n\n")
    r.append("**If 3 of 4 are NO:** archive SPEC/IDENTITY/CONTRACTS as research artifacts. Existing 38 agents + Nx + CI cover the value surface.  \n")
    r.append("**If 3 of 4 are YES:** proceed to Phase 0 — kernel skeleton (orchestrator state machine + Discovery + Memory + budget gate + kill switch + integrity hash chain). No skills yet.\n\n")
    r.append("---\n\n")
    r.append("_Generated by `tools/aria-poc/poc.py` (no LLM, no API)._  \n")
    digest = hashlib.sha256(repr(fp).encode()).hexdigest()[:16]
    r.append(f"_Fingerprint SHA-256 (first 16):_ `{digest}`\n")
    out = out_dir / "aria-poc-report.md"
    out.write_text("".join(r), encoding="utf-8")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="ARIA Phase-1 PoC — operator decision tool")
    ap.add_argument("--workspace-root", default=".", help="Repo root (default: cwd)")
    ap.add_argument("--out-dir", default=".aria-poc", help="Output dir relative to repo root")
    ap.add_argument("--skip-nx-graph", action="store_true", help="Skip nx graph subprocess call")
    args = ap.parse_args()

    repo_root = Path(args.workspace_root).resolve()
    out_dir = (repo_root / args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"[aria-poc] repo:   {repo_root}")
    print(f"[aria-poc] output: {out_dir}")

    print("[aria-poc] phase 1: walking filesystem...")
    files = walk_repo(repo_root)
    git_set = git_ls_files(repo_root)
    print(f"[aria-poc]   filesystem: {len(files)} files; git ls-files: {len(git_set)}")

    print("[aria-poc] phase 2: assigning fates...")
    fates = [assign_fate(p, repo_root) for p in files]

    print("[aria-poc] phase 3: computing fingerprint...")
    fp = compute_fingerprint(repo_root, fates)
    (out_dir / "REPO_FINGERPRINT.json").write_text(
        json.dumps(dataclasses.asdict(fp), indent=2), encoding="utf-8",
    )

    print("[aria-poc] phase 4: ingesting trusted priors...")
    artifacts: list[str] = []
    p1 = write_claude_md_priors(repo_root, out_dir)
    if p1:
        artifacts.append(str(p1.relative_to(repo_root)))
    p2, n_adr = write_adr_priors(repo_root, out_dir)
    if p2:
        artifacts.append(f"{p2.relative_to(repo_root)} ({n_adr} ADRs)")
    p3, n_agent = write_agent_priors(repo_root, out_dir)
    if p3:
        artifacts.append(f"{p3.relative_to(repo_root)} ({n_agent} agents)")

    if not args.skip_nx_graph:
        print("[aria-poc] phase 5: running nx graph (best-effort)...")
        if run_nx_graph(repo_root, out_dir):
            artifacts.append(str((out_dir / "BUILD_GRAPH.json").relative_to(repo_root)))
            print("[aria-poc]   nx graph captured")
        else:
            print("[aria-poc]   nx graph unavailable, skipping")

    print("[aria-poc] phase 6: mechanical drift scan...")
    ts_enums = detect_ts_enums(repo_root, fates)
    sql_enums = detect_sql_enums(repo_root, fates)
    print(f"[aria-poc]   ts enums: {len(ts_enums)}; sql enums: {len(sql_enums)}")
    drifts = find_drifts(ts_enums, sql_enums)
    print(f"[aria-poc]   drift candidates: {len(drifts)}")
    (out_dir / "MECHANICAL_DRIFTS.json").write_text(
        json.dumps({"ts_enums": ts_enums, "sql_enums": sql_enums, "drifts": drifts}, indent=2),
        encoding="utf-8",
    )

    print("[aria-poc] phase 7: writing report...")
    report = write_report(out_dir, fp, fates, drifts, artifacts)
    print(f"[aria-poc] DONE. Report: {report}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
