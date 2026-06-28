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

# Plan ARIA-V2 §3.6 — guarantee that ``tools.shared.excluded_paths`` is
# importable regardless of how the PoC is invoked (standalone script
# from any CWD, ``python3 -m unittest discover ...``, or imported
# inside CI). Computing the repo root from ``__file__`` is the
# Tier-1 architectural fix: the import resolution becomes a
# function of file layout, not operator-environment PYTHONPATH.
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from tools.shared.excluded_paths import (
    BASE_EXCLUDED_DIRS as EXCLUDED_DIRS,
    augmented_excluded_paths,
)

LANGUAGE_BY_EXT: dict[str, str] = {
    ".ts": "typescript", ".tsx": "typescript",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript",
    ".rs": "rust", ".py": "python",
    ".sql": "sql", ".md": "markdown",
    ".yaml": "yaml", ".yml": "yaml",
    ".json": "json", ".toml": "toml",
    ".sh": "shell", ".html": "html", ".css": "css", ".scss": "scss",
    ".graphql": "graphql", ".gql": "graphql",
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
TS_UNION_PATTERN = re.compile(
    r"(?:export\s+)?type\s+(\w+)\s*=\s*((?:\s*['\"][^'\"]+['\"]\s*(?:\|\s*)?)+)\s*;?",
    re.MULTILINE,
)
TS_CONST_ARRAY_PATTERN = re.compile(
    r"(?:export\s+)?const\s+(\w+)\s*=\s*(\[(?:\s*['\"][^'\"]+['\"]\s*,?)+\s*\])\s+as\s+const",
    re.MULTILINE | re.DOTALL,
)
ZOD_ENUM_PATTERN = re.compile(
    r"(?:export\s+)?const\s+(\w+)\s*=\s*z\.enum\s*\(\s*(\[[\s\S]*?\])\s*\)",
    re.MULTILINE | re.DOTALL,
)
GRAPHQL_ENUM_PATTERN = re.compile(
    r"\benum\s+(\w+)\s*\{([^}]+)\}",
    re.MULTILINE | re.DOTALL,
)
SQL_ENUM_PATTERN = re.compile(
    r"CREATE\s+TYPE\s+(\w+)\s+AS\s+ENUM\s*\(([^)]+)\)",
    re.IGNORECASE | re.DOTALL,
)
# Rust enum declaration head: `pub enum Foo {` / `enum Foo<T> {`. The body is
# brace-matched in code (struct variants nest braces, so a flat `[^}]+` like the
# TS pattern would truncate). Brings ~210k LOC of edge/Rust enums into the same
# cross-language drift net as TS/SQL/GraphQL (ADR-025 sidecar, event contracts
# shared across the Rust↔TS boundary).
RUST_ENUM_HEAD_PATTERN = re.compile(
    r"(?:pub(?:\s*\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)\s*(?:<[^>{]*>)?\s*\{",
    re.MULTILINE,
)
UI_SAFE_CONCEPT_TOKENS: tuple[str, ...] = (
    "status", "type", "state", "phase", "category", "priority",
    "severity", "kind", "mode",
)
UI_IGNORED_VALUES: set[str] = {"", "all", "any", "none", "null", "undefined"}
NAME_STOPWORDS: set[str] = {
    "option", "options", "select", "selector", "filter", "filters",
    "menu", "items", "item", "dropdown", "field", "input", "value",
    "values", "list", "set", "sets", "request",
}
GENERIC_CONCEPT_TOKENS: set[str] = {
    "status", "type", "state", "phase", "category", "priority",
    "severity", "kind", "mode", "enum",
}


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


# ─── walk_repo ───────────────────────────────────────────────────────────
# Repo'yu kök dizinden itibaren gezer. EXCLUDED_DIRS'daki dizinleri
# `dirs[:] = ...` slice trick'i ile yerinde filtreler — bu dizinlere hiç
# inmez, CPU+IO tasarrufu sağlar. Çıktı: ARIA Discovery engine'in göreceği
# tüm app dosyalarının Path listesi. agent-workspace, node_modules,
# build artefakt'ları, .git burada filtreden geçer.
def walk_repo(repo_root: Path) -> list[Path]:
    out: list[Path] = []
    for root, dirs, files in os.walk(repo_root):
        dirs[:] = [d for d in dirs if d not in EXCLUDED_DIRS]
        rp = Path(root)
        for f in files:
            if f == ".git":
                continue
            out.append(rp / f)
    return out


def normalize_concept_name(name: str) -> str:
    """Normalize related enum/type/option names without collapsing repeatedly."""
    n = re.sub(r"[^a-zA-Z0-9_]", "_", name).lower()
    n = re.sub(r"_+", "_", n).strip("_")
    suffixes_priority = (
        "_options", "_statuses", "_status", "_types", "_type",
        "_states", "_state", "_phases", "_phase", "_categories",
        "_category", "_priorities", "_priority", "_severities",
        "_severity", "_kinds", "_kind", "_modes", "_mode",
        "_enum", "_select", "_filter", "_filters",
        "options", "statuses", "status", "types", "type", "states",
        "state", "phases", "phase", "categories", "category",
        "priorities", "priority", "severities", "severity", "kinds",
        "kind", "modes", "mode", "enum", "select", "filter", "filters",
    )
    for suffix in suffixes_priority:
        if n.endswith(suffix) and len(n) > len(suffix):
            return n[: -len(suffix)].strip("_")
    return n


def lower_values(values: list[str]) -> set[str]:
    return {v.lower() for v in values if v.lower() not in UI_IGNORED_VALUES}


def jaccard(a: set[str], b: set[str]) -> float:
    if not a and not b:
        return 1.0
    return len(a & b) / max(len(a | b), 1)


def split_name_tokens(name: str) -> set[str]:
    """Tokenize identifiers without making value overlap a relationship."""
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", name)
    spaced = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", spaced)
    raw = re.split(r"[^A-Za-z0-9]+", spaced.lower())
    return {t for t in raw if t and t not in NAME_STOPWORDS}


def concept_tokens(name: str) -> set[str]:
    tokens = split_name_tokens(name)
    normalized = normalize_concept_name(name)
    tokens.update(split_name_tokens(normalized))
    return tokens


def meaningful_concept_tokens(name: str) -> set[str]:
    return concept_tokens(name) - GENERIC_CONCEPT_TOKENS


def compact_concept_key(name: str) -> str:
    return normalize_concept_name(name).replace("_", "")


def surface_of_path(path: str) -> str:
    """Coarse repo-shape classifier used to keep adapters on their surface."""
    if is_test_source_path(path):
        return "test"
    if (
        "/generated/" in path
        or "/__generated__/" in path
        or path.startswith(("dist/", "build/", ".nx/", "coverage/"))
        or path.endswith((".d.ts", ".map"))
    ):
        return "generated"
    if path.startswith(("docs/", ".claude/")) or path in {"CLAUDE.md", "AGENTS.md"}:
        return "docs"
    if "/database/migrations/" in path or "/migrations/" in path:
        return "migration"
    if path.startswith(("web/modules/", "web/apps/", "web/shared-ui/")):
        if path.endswith((".tsx", ".jsx")):
            return "frontend_ui"
        return "frontend_source"
    if path.startswith("apps/"):
        return "backend_app"
    if path.startswith(("platform/libs/", "libs/")):
        return "shared_lib"
    # Rust edge gateway + workspace crates (ADR-025). Previously "unknown",
    # which hid the edge surface from drift triage.
    if path.startswith(("sens-api-gateway/", "crates/")) or path.endswith(".rs"):
        return "edge_source"
    return "unknown"


def service_of(ref: str) -> str:
    path = ref.split(":", 1)[0]
    for prefix in ("web/apps/", "web/modules/", "web/shared-ui/", "apps/", "platform/libs/", "libs/"):
        if path.startswith(prefix):
            tail = path[len(prefix):]
            return prefix + tail.split("/", 1)[0]
    return "unknown"


def surrounding_symbol(text: str, index: int) -> str:
    """Best-effort component/function name for UI option groups."""
    window = text[max(0, index - 3000):index]
    matches = list(re.finditer(
        r"(?:export\s+default\s+)?function\s+(\w+)\s*\(|(?:export\s+)?const\s+(\w+)\s*[:=]",
        window,
    ))
    if not matches:
        return "unknown"
    last = matches[-1]
    return (last.group(1) or last.group(2) or "unknown").strip()


def attr_value(attrs: str, name: str) -> str:
    m = re.search(rf"\b{name}\s*=\s*['\"]([^'\"]+)['\"]", attrs)
    return m.group(1).strip() if m else ""


def extract_literal_values(text: str) -> list[str]:
    """Extract string literals from option/value object shapes."""
    values: list[str] = []
    values.extend(re.findall(r"\bvalue\s*:\s*['\"]([^'\"]+)['\"]", text))
    values.extend(re.findall(r"<(?:option|MenuItem)\b[^>]*\bvalue\s*=\s*['\"]([^'\"]+)['\"]", text))
    if not values:
        values.extend(re.findall(r"['\"]([A-Za-z0-9_./:-]+)['\"]", text))
    cleaned = [v.strip() for v in values if v.strip().lower() not in UI_IGNORED_VALUES]
    return sorted(set(cleaned))


def is_test_source_path(path: str) -> bool:
    return (
        "/__tests__/" in path
        or "/tests/" in path
        or path.startswith("e2e/")
        or path.endswith((".spec.ts", ".spec.tsx", ".test.ts", ".test.tsx"))
    )


# ─── git_ls_files ────────────────────────────────────────────────────────
# `git ls-files` subprocess çağırır → tracked dosya path'leri set'i. Walk
# çıktısı ile karşılaştırılır: gap'leri GIT_RECONCILIATION.json açıklar
# (in-git-but-not-walked = excluded-dir'da tracked; walked-but-not-in-git
# = untracked). git yoksa boş set döner — sessizce degrade.
def git_ls_files(repo_root: Path) -> set[str]:
    try:
        r = subprocess.run(
            ["git", "-C", str(repo_root), "ls-files"],
            capture_output=True, text=True, check=True, timeout=60,
        )
        return set(r.stdout.strip().splitlines())
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        return set()


# ─── assign_fate ─────────────────────────────────────────────────────────
# Coverage Invariant'ın çekirdeği: HER dosyaya bir fate atanır
# (read_deeply | read_skimmed | skipped_with_reason). Bilinen manifest +
# desteklenen dil = deeply; binary/asset = skipped; gerisi = skim.
# Hiçbir dosya sessizce yok sayılmaz — gözlerden kaçmama disiplini.
def assign_fate(path: Path, repo_root: Path) -> FileFate:
    rel = str(path.relative_to(repo_root))
    ext = path.suffix.lower()
    name = path.name
    if name in MANIFEST_FILES or ext in LANGUAGE_BY_EXT:
        return FileFate(rel, "read_deeply")
    if ext in {".lock", ".log", ".map", ".png", ".jpg", ".svg", ".ico", ".pdf"}:
        return FileFate(rel, "skipped_with_reason", "binary/generated/asset")
    return FileFate(rel, "read_skimmed", "no specialized adapter")


# ─── compute_fingerprint ─────────────────────────────────────────────────
# Repo'nun "boyutunu" mekanik özetler: dil histogramı, manifest tipleri,
# servis sayıları (apps/ + web/modules/), migration sayısı, ADR sayısı,
# specialized agent sayısı, nx workspace var mı. Bu fingerprint operatöre
# "bu repo neye benziyor" sorusuna LLM'siz cevap veren tek anchor.
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


# ─── write_claude_md_priors ──────────────────────────────────────────────
# CLAUDE.md TRUSTED prior olarak ingest edilir (SPEC §5.1). Mekanik
# extraction: heading'leri çıkartır, content SHA-256'sını kaydeder. LLM
# özeti yok; full ARIA gelince bu mekanik extract'in üstüne anlam
# katmanı oturur. Şimdilik sadece "neyin ingestlendi" kanıtı.
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


# ─── write_adr_priors ────────────────────────────────────────────────────
# docs/adr/[0-9][0-9][0-9]-*.md sadece (CLAUDE.md known-drift listesindeki
# misfile'lar atlanır). Her ADR'den title + status mekanik regex ile
# çıkartılır. Bu output ARIA için TRUSTED prior — full ARIA bunu Day 0'da
# yükleyip mimari kararları belief olarak saklar.
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


# ─── write_agent_priors ──────────────────────────────────────────────────
# 38+ specialized review agent'ın frontmatter'ından `description` çekilir.
# AGENT_PRIORS.md, full ARIA'nın "bu drift hangi domain agent'ın işine
# girer" sorusunu çözmek için kullanacağı path → agent mapping'in ham
# malzemesi (CONTRACTS §1.2 #13 agent-priors-mapper). PoC sadece
# mekanik index üretir; mapping'i full ARIA kuracak.
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


# ─── run_nx_graph ────────────────────────────────────────────────────────
# `npx nx graph --file=...` subprocess olarak çağırır. Çıktı: nx'in tam
# project dependency graph'ı JSON formatında. Full ARIA bunu kullanarak
# cross-service drift severity'sini dependency depth ile ağırlıklandırır
# (SPEC §9.6 + CONTRACTS §1.2 #12 nx-graph adapter). nx yoksa False
# döner — best-effort degrade.
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


# ─── detect_ts_enums ─────────────────────────────────────────────────────
# Pattern manifest: `enum Foo { A, B, C }` (export'lı veya değil).
# Yorum satırlarını (// ve /* */) split öncesi temizler — Türkçe yorumlu
# enum body'lerinde yorumların value gibi yakalanması bug'ı çözüldü.
# Identifier regex (^[A-Za-z_][A-Za-z0-9_]*$) garbage'ı eler.
# Bu, full ARIA'nın `typescript-nestjs-cqrs` adapter'ının (CONTRACTS §1.2
# #1) bir alt parçası — burada izole + jenerik biçimde.
def detect_ts_enums(repo_root: Path, fates: list[FileFate]) -> list[dict]:
    enums: list[dict] = []
    for f in fates:
        if not f.path.endswith((".ts", ".tsx")):
            continue
        if f.path.endswith(".d.ts") or is_test_source_path(f.path):
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
                "kind": "enum",
                "surface": surface_of_path(f.path),
            })
    return enums


# ─── detect_rust_enums ───────────────────────────────────────────────────
# Rust variant names from an enum body. Unit (`A`), tuple (`A(x)`), struct
# (`A { x: u8 }`), and discriminant (`A = 1`) variants all reduce to the
# leading identifier of each top-level (comma-separated) segment. Depth is
# tracked on ()[]{} only — NOT <> (shift `<<` in a discriminant would miscount;
# generics inside variants live within paren/brace depth and are unaffected).
def _rust_variant_names(body: str) -> list[str]:
    body = re.sub(r"//[^\n]*", "", body)
    body = re.sub(r"/\*.*?\*/", "", body, flags=re.DOTALL)
    segments: list[str] = []
    buf: list[str] = []
    depth = 0
    for ch in body:
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth = max(0, depth - 1)
        if ch == "," and depth == 0:
            segments.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    if buf:
        segments.append("".join(buf))
    names: list[str] = []
    for seg in segments:
        seg = re.sub(r"#\[[^\]]*\]", "", seg).strip()  # strip variant attributes
        m = re.match(r"([A-Za-z_]\w*)", seg)
        if m:
            names.append(m.group(1))
    return names


def detect_rust_enums(repo_root: Path, fates: list[FileFate]) -> list[dict]:
    enums: list[dict] = []
    for f in fates:
        if not f.path.endswith(".rs"):
            continue
        if is_test_source_path(f.path) or any(
            seg in f.path for seg in ("/target/", "/fuzz/", "/benches/")
        ):
            continue
        full = repo_root / f.path
        try:
            text = full.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for m in RUST_ENUM_HEAD_PATTERN.finditer(text):
            name = m.group(1)
            open_idx = m.end() - 1  # the '{'
            depth = 0
            body = None
            for i in range(open_idx, len(text)):
                c = text[i]
                if c == "{":
                    depth += 1
                elif c == "}":
                    depth -= 1
                    if depth == 0:
                        body = text[open_idx + 1:i]
                        break
            if body is None:
                continue
            values = sorted(set(_rust_variant_names(body)))
            if not values:
                continue
            line = text[: m.start()].count("\n") + 1
            enums.append({
                "name": name,
                "values": values,
                "ref": f"{f.path}:{line}",
                "kind": "rust_enum",
                "surface": surface_of_path(f.path),
            })
    return enums


# ─── detect_ts_union_types ───────────────────────────────────────────────
# Pattern manifest: `type FooStatus = 'a' | 'b' | 'c'`. Modern TS code
# often uses literal unions instead of enum. The detector only accepts pure
# string-literal unions with 2+ values; wider unions stay invisible rather
# than producing noisy partial data.
def detect_ts_union_types(repo_root: Path, fates: list[FileFate]) -> list[dict]:
    unions: list[dict] = []
    for f in fates:
        if not f.path.endswith((".ts", ".tsx")):
            continue
        if f.path.endswith(".d.ts") or is_test_source_path(f.path):
            continue
        full = repo_root / f.path
        try:
            text = full.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for m in TS_UNION_PATTERN.finditer(text):
            name = m.group(1)
            body = m.group(2)
            values = re.findall(r"['\"]([^'\"]+)['\"]", body)
            values = sorted(set(v.strip() for v in values if v.strip()))
            if len(values) < 2:
                continue
            line = text[: m.start()].count("\n") + 1
            unions.append({
                "name": name,
                "values": values,
                "ref": f"{f.path}:{line}",
                "kind": "union",
                "surface": surface_of_path(f.path),
            })
    return unions


def detect_ts_const_arrays(repo_root: Path, fates: list[FileFate]) -> list[dict]:
    """Pattern: `export const FooValues = ['a', 'b'] as const`."""
    sets: list[dict] = []
    for f in fates:
        if not f.path.endswith((".ts", ".tsx")):
            continue
        if f.path.endswith(".d.ts") or is_test_source_path(f.path):
            continue
        full = repo_root / f.path
        try:
            text = full.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for m in TS_CONST_ARRAY_PATTERN.finditer(text):
            name = m.group(1)
            values = extract_literal_values(m.group(2))
            if len(values) < 2:
                continue
            line = text[: m.start()].count("\n") + 1
            sets.append({
                "name": name,
                "values": values,
                "ref": f"{f.path}:{line}",
                "kind": "const_array",
                "surface": surface_of_path(f.path),
            })
    return sets


def detect_zod_enums(repo_root: Path, fates: list[FileFate]) -> list[dict]:
    """Pattern: `const FooSchema = z.enum(['a', 'b'])`."""
    sets: list[dict] = []
    for f in fates:
        if not f.path.endswith((".ts", ".tsx")):
            continue
        if f.path.endswith(".d.ts") or is_test_source_path(f.path):
            continue
        full = repo_root / f.path
        try:
            text = full.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for m in ZOD_ENUM_PATTERN.finditer(text):
            name = m.group(1)
            values = extract_literal_values(m.group(2))
            if len(values) < 2:
                continue
            line = text[: m.start()].count("\n") + 1
            sets.append({
                "name": name,
                "values": values,
                "ref": f"{f.path}:{line}",
                "kind": "zod_enum",
                "surface": surface_of_path(f.path),
            })
    return sets


def detect_graphql_enums(repo_root: Path, fates: list[FileFate]) -> list[dict]:
    """Pattern: GraphQL SDL `enum Foo { A B C }`."""
    sets: list[dict] = []
    for f in fates:
        if not f.path.endswith((".graphql", ".gql")):
            continue
        if is_test_source_path(f.path):
            continue
        full = repo_root / f.path
        try:
            text = full.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for m in GRAPHQL_ENUM_PATTERN.finditer(text):
            name = m.group(1)
            body = re.sub(r"#[^\n]*", "", m.group(2))
            values = []
            for raw in re.split(r"[\s,]+", body):
                v = raw.strip()
                if re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", v):
                    values.append(v)
            values = sorted(set(values))
            if len(values) < 2:
                continue
            line = text[: m.start()].count("\n") + 1
            sets.append({
                "name": name,
                "values": values,
                "ref": f"{f.path}:{line}",
                "kind": "graphql_enum",
                "surface": surface_of_path(f.path),
            })
    return sets


# ─── detect_ui_option_groups ─────────────────────────────────────────────
# Pattern manifest: frontend literal option groups. This is intentionally
# conservative: it records many groups for visibility, but drift promotion
# later requires a safe concept token + value overlap. Generic timezone,
# sort, and "all" filters should stay as raw option groups, not findings.
def detect_ui_option_groups(repo_root: Path, fates: list[FileFate]) -> list[dict]:
    groups: list[dict] = []
    for f in fates:
        if surface_of_path(f.path) != "frontend_ui":
            continue
        full = repo_root / f.path
        try:
            text = full.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        # Native select blocks.
        for m in re.finditer(r"<select\b(?P<attrs>[^>]*)>(?P<body>.*?)</select>", text, re.DOTALL):
            attrs = m.group("attrs")
            body = m.group("body")
            values = extract_literal_values(body)
            if len(values) < 2:
                continue
            symbol = surrounding_symbol(text, m.start())
            name = attr_value(attrs, "name") or attr_value(attrs, "id") or symbol
            line = text[: m.start()].count("\n") + 1
            groups.append({
                "name": name,
                "component": symbol,
                "values": values,
                "ref": f"{f.path}:{line}",
                "kind": "ui_option_group",
                "source": "select",
                "surface": surface_of_path(f.path),
            })

        # Inline component options={[{ value: 'x' }, ...]} blocks.
        for m in re.finditer(r"\boptions\s*=\s*\{\s*(\[[\s\S]*?\])\s*\}", text):
            body = m.group(1)
            values = extract_literal_values(body)
            if len(values) < 2:
                continue
            symbol = surrounding_symbol(text, m.start())
            line = text[: m.start()].count("\n") + 1
            groups.append({
                "name": f"{symbol}Options",
                "component": symbol,
                "values": values,
                "ref": f"{f.path}:{line}",
                "kind": "ui_option_group",
                "source": "inline_options",
                "surface": surface_of_path(f.path),
            })

        # Named option arrays: const statusOptions = [...]
        option_name = r"\w*(?:Options|Statuses|Types|States|Phases|Categories|Priorities|Severities|Kinds|Modes)\w*"
        const_pattern = re.compile(rf"\bconst\s+({option_name})\s*=\s*(\[[\s\S]*?\]);?", re.DOTALL)
        for m in const_pattern.finditer(text):
            name = m.group(1)
            body = m.group(2)
            values = extract_literal_values(body)
            if len(values) < 2:
                continue
            symbol = surrounding_symbol(text, m.start())
            line = text[: m.start()].count("\n") + 1
            groups.append({
                "name": name,
                "component": symbol,
                "values": values,
                "ref": f"{f.path}:{line}",
                "kind": "ui_option_group",
                "source": "const_options",
                "surface": surface_of_path(f.path),
            })

        # Material UI-style sibling MenuItem values, grouped by component.
        menu_values = extract_literal_values("\n".join(
            re.findall(r"<MenuItem\b[^>]*>.*?</MenuItem>", text, flags=re.DOTALL)
        ))
        if len(menu_values) >= 2:
            first = text.find("<MenuItem")
            symbol = surrounding_symbol(text, first)
            line = text[: first].count("\n") + 1
            groups.append({
                "name": f"{symbol}MenuItems",
                "component": symbol,
                "values": menu_values,
                "ref": f"{f.path}:{line}",
                "kind": "ui_option_group",
                "source": "menu_items",
                "surface": surface_of_path(f.path),
            })
    return groups


# ─── detect_sql_enums ────────────────────────────────────────────────────
# Pattern manifest: `CREATE TYPE foo AS ENUM ('a', 'b', 'c')` — sadece
# apps/*/src/database/migrations/ altında. Bu repo'da tüm SQL enum'lar
# TypeORM migration'larından geliyor (ADR-011 schema-per-tenant).
# Full ARIA'nın `sql-typeorm-migration` adapter'ının (CONTRACTS §1.2 #7)
# bir alt parçası.
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
                "kind": "sql_enum",
                "surface": surface_of_path(f.path),
            })
    return enums


# ─── find_drifts ─────────────────────────────────────────────────────────
# Drift detection iki katmanlı:
#   1) İsim eşleştirme: tek-suffix strip (priority _enum > _status > _type
#      > enum > status > type). Çoklu strip ETMEK YOK — eski kod
#      DepartmentStatus + DepartmentType + department_type'i `department`'a
#      collapse ediyordu, false positive üretiyordu.
#   2) Value-set Jaccard similarity ≥ jaccard_threshold (default 0.3).
#      Düşükse drifts_filtered'a düşer (görünür ama main listede değil).
# Cross-service flag: TS path'in apps/X'i ile SQL path'in apps/X'i farklı
# mı? (categorically more critical — PR-cycle agent'ları yakalayamaz).
# Sıralama: cross-service ilk, sonra similarity desc.
def _dedup_enums(enums: list[dict]) -> list[dict]:
    """Plan ARIA-V2 §3.6 + I-20 — pre-Cartesian dedup pass.

    Collapses entries with the same normalized concept name AND the
    same value set (case-insensitive, sorted) into a single survivor.
    The survivor carries ``dedup_collapsed_refs: [refs of duplicates]``
    so later phases (and audit) can trace what was suppressed.

    Why pre-Cartesian: ``find_drifts`` walks every ts × sql pair under
    a shared normalized name. M identical ts rows produce M times the
    drifts of any one. Without dedup, a repo with a re-exported enum
    inflates the MECHANICAL_DRIFTS list by a multiplicative factor
    (ARIA-V-003 reproduction: 126 vs ~10 on actual evidence).

    Dedup key: ``(normalize_concept_name(name), tuple(sorted(lower_values(values))))``.
    Insertion order of the first occurrence is preserved.
    """
    by_key: dict[tuple, dict] = {}
    for entry in enums:
        key = (
            normalize_concept_name(entry.get("name", "")),
            tuple(sorted(lower_values(entry.get("values", [])))),
        )
        existing = by_key.get(key)
        if existing is None:
            survivor = dict(entry)
            survivor["dedup_collapsed_refs"] = []
            by_key[key] = survivor
        else:
            existing["dedup_collapsed_refs"].append(entry.get("ref", ""))
    return list(by_key.values())


def find_drifts(ts_enums: list[dict], sql_enums: list[dict],
                jaccard_threshold: float = 0.3) -> tuple[list[dict], list[dict]]:
    """Returns (drifts_above_threshold, drifts_filtered_out).

    Normalization strips at most ONE suffix (longest matching first) to avoid
    DepartmentStatus + DepartmentType + department_type all collapsing to
    'department' (over-aggressive collision per identified PoC eksik #5).

    Jaccard similarity on lowercase value sets must exceed `jaccard_threshold`
    to count as same concept. Below-threshold matches are still recorded
    (for transparency / skill calibration) but split into a separate list.

    Plan ARIA-V2 §3.6 + I-20: pre-Cartesian ``_dedup_enums`` pass
    collapses semantically-identical inputs (same normalized name +
    same value set) into a single representative carrying
    ``dedup_collapsed_refs``; this is the architectural fix for
    ARIA-V-003 (drift inflation from re-exported enums).
    """
    ts_enums = _dedup_enums(ts_enums)
    sql_enums = _dedup_enums(sql_enums)
    by_norm_ts: dict[str, list[dict]] = {}
    for e in ts_enums:
        by_norm_ts.setdefault(normalize_concept_name(e["name"]), []).append(e)

    drifts_above: list[dict] = []
    drifts_filtered: list[dict] = []
    for sql in sql_enums:
        for ts in by_norm_ts.get(normalize_concept_name(sql["name"]), []):
            ts_vals = lower_values(ts["values"])
            sql_vals = lower_values(sql["values"])
            if ts_vals == sql_vals:
                continue  # no drift
            similarity = jaccard(ts_vals, sql_vals)
            ts_service = service_of(ts["ref"])
            sql_service = service_of(sql["ref"])
            entry = {
                "concept": normalize_concept_name(sql["name"]),
                "ts": ts,
                "sql": sql,
                "missing_in_ts": sorted(sql_vals - ts_vals),
                "missing_in_sql": sorted(ts_vals - sql_vals),
                "value_jaccard_similarity": round(similarity, 3),
                "cross_service": ts_service != sql_service,
                "ts_service": ts_service,
                "sql_service": sql_service,
            }
            if similarity >= jaccard_threshold:
                drifts_above.append(entry)
            else:
                entry["filter_reason"] = f"value_jaccard_similarity {round(similarity, 3)} below threshold {jaccard_threshold}; likely false-positive name collision"
                drifts_filtered.append(entry)
    # Sort: cross_service drifts first (they are categorically more critical)
    drifts_above.sort(key=lambda d: (not d["cross_service"], -d["value_jaccard_similarity"]))
    return drifts_above, drifts_filtered


def ui_group_has_safe_name(group: dict) -> bool:
    raw = f"{group.get('name', '')} {group.get('component', '')}".lower()
    return any(token in raw for token in UI_SAFE_CONCEPT_TOKENS)


def relationship_reason(ui: dict, source: dict) -> str | None:
    ui_norm = normalize_concept_name(ui["name"])
    source_norm = normalize_concept_name(source["name"])
    if ui_norm and source_norm and (ui_norm == source_norm or ui_norm in source_norm or source_norm in ui_norm):
        return "normalized_name_match"
    ui_tokens = meaningful_concept_tokens(f"{ui.get('name', '')} {ui.get('component', '')}")
    source_tokens = meaningful_concept_tokens(source["name"])
    shared = sorted(ui_tokens & source_tokens)
    if shared:
        return "shared_concept_tokens:" + ",".join(shared)
    ui_file = ui["ref"].split(":", 1)[0]
    source_file = source["ref"].split(":", 1)[0]
    if ui_file == source_file:
        return "same_file"
    return None


def related_by_name_or_overlap(ui: dict, source: dict, threshold: float) -> bool:
    reason = relationship_reason(ui, source)
    if reason in {"normalized_name_match", "same_file"} or (reason or "").startswith("shared_concept_tokens:"):
        return True
    return False


def nearest_value_sets(ui: dict, sources: list[dict], limit: int = 3) -> list[dict]:
    rows: list[dict] = []
    ui_vals = lower_values(ui["values"])
    for source in sources:
        source_vals = lower_values(source["values"])
        reason = relationship_reason(ui, source)
        similarity = jaccard(ui_vals, source_vals)
        rows.append({
            "name": source["name"],
            "kind": source.get("kind", "sql_enum"),
            "ref": source["ref"],
            "surface": source.get("surface", "unknown"),
            "relationship": reason,
            "value_jaccard_similarity": round(similarity, 3),
        })
    rows.sort(key=lambda r: (r["relationship"] is None, -r["value_jaccard_similarity"], r["ref"]))
    return rows[:limit]


def annotate_ui_option_groups(ts_value_sets: list[dict], sql_enums: list[dict],
                              ui_option_groups: list[dict],
                              jaccard_threshold: float = 0.5) -> tuple[list[dict], list[dict]]:
    annotated: list[dict] = []
    drifts: list[dict] = []
    sources = [*ts_value_sets, *sql_enums]
    for ui in ui_option_groups:
        enriched = dict(ui)
        enriched["nearest_value_sets"] = nearest_value_sets(ui, sources)
        enriched["promotion_status"] = "suppressed"
        enriched["promotion_reason"] = "not_evaluated"
        if not ui_group_has_safe_name(ui):
            enriched["promotion_reason"] = "unsafe_name"
            annotated.append(enriched)
            continue
        ui_vals = lower_values(ui["values"])
        if len(ui_vals) < 2:
            enriched["promotion_reason"] = "too_few_values"
            annotated.append(enriched)
            continue

        related_sources = [
            source for source in sources
            if relationship_reason(ui, source) is not None
        ]
        if not related_sources:
            enriched["promotion_reason"] = "no_related_value_set"
            annotated.append(enriched)
            continue

        promoted = False
        low_similarity_seen = False
        equal_seen = False
        for source in related_sources:
            source_vals = lower_values(source["values"])
            similarity = jaccard(ui_vals, source_vals)
            if ui_vals == source_vals:
                equal_seen = True
                continue
            if similarity < jaccard_threshold:
                low_similarity_seen = True
                continue
            reason = relationship_reason(ui, source) or "unknown"
            drift = {
                "claim_type": "frontend_dropdown_drift",
                "concept": normalize_concept_name(source["name"]),
                "ui": enriched,
                "source": source,
                "source_kind": source.get("kind", "sql_enum"),
                "relationship": reason,
                "missing_in_ui": sorted(source_vals - ui_vals),
                "missing_in_source": sorted(ui_vals - source_vals),
                "value_jaccard_similarity": round(similarity, 3),
                "cross_service": service_of(ui["ref"]) != service_of(source["ref"]),
                "ui_service": service_of(ui["ref"]),
                "source_service": service_of(source["ref"]),
            }
            drifts.append(drift)
            promoted = True

        if promoted:
            enriched["promotion_status"] = "promoted"
            enriched["promotion_reason"] = "related_value_set_drift"
        elif equal_seen:
            enriched["promotion_reason"] = "matches_related_value_set"
        elif low_similarity_seen:
            enriched["promotion_reason"] = "low_similarity"
        else:
            enriched["promotion_reason"] = "no_drift"
        annotated.append(enriched)

    drifts.sort(key=lambda d: (not d["cross_service"], -d["value_jaccard_similarity"], d["ui"]["ref"]))
    seen: dict[tuple[str, str], dict] = {}
    unique: list[dict] = []
    for d in drifts:
        source_summary = {
            "name": d["source"]["name"],
            "kind": d["source_kind"],
            "ref": d["source"]["ref"],
            "relationship": d["relationship"],
            "value_jaccard_similarity": d["value_jaccard_similarity"],
            "missing_in_ui": d["missing_in_ui"],
            "missing_in_source": d["missing_in_source"],
        }
        key = (d["ui"]["ref"], compact_concept_key(d["concept"]))
        if key not in seen:
            d["supporting_sources"] = [source_summary]
            seen[key] = d
            unique.append(d)
        else:
            existing = seen[key]
            existing["supporting_sources"].append(source_summary)
            existing["missing_in_ui"] = sorted(set(existing["missing_in_ui"]) | set(d["missing_in_ui"]))
            existing["missing_in_source"] = sorted(set(existing["missing_in_source"]) | set(d["missing_in_source"]))
            existing["cross_service"] = existing["cross_service"] or d["cross_service"]
    return annotated, unique


# ─── find_frontend_dropdown_drifts ───────────────────────────────────────
# UI option groups are noisy by nature, so they never join the main
# TS↔SQL drift list directly. Promotion requires (1) a safe concept name
# and (2) a related TS/SQL value set by name or strong value overlap.
def find_frontend_dropdown_drifts(ts_value_sets: list[dict], sql_enums: list[dict],
                                  ui_option_groups: list[dict],
                                  jaccard_threshold: float = 0.5) -> list[dict]:
    _, drifts = annotate_ui_option_groups(
        ts_value_sets, sql_enums, ui_option_groups, jaccard_threshold,
    )
    return drifts


# ─── write_fates_json ────────────────────────────────────────────────────
# Coverage Invariant'ın diske yazılı kanıtı. Operatör "X dosyasını PoC
# gerçekten gördü mü?" sorusunu jq ile cevaplayabilir. Önceki sürüm
# sadece sayı veriyordu (audit zayıf); şimdi her dosya için
# {path, fate, reason} JSON ledger.
def write_fates_json(out_dir: Path, fates: list[FileFate]) -> Path:
    """Coverage Invariant proof — every file with its fate, queryable."""
    out = out_dir / "FATES.json"
    out.write_text(
        json.dumps(
            [{"path": f.path, "fate": f.fate, "reason": f.reason} for f in fates],
            indent=2,
        ),
        encoding="utf-8",
    )
    return out


# ─── write_skimmed_files ─────────────────────────────────────────────────
# read_skimmed + skipped_with_reason dosyalarını listeler. PoC'nin
# "körlük" alanı: hangi dosyalara mekanik adapter uygulamadı, hangi
# dosyaları binary diye atladı. Coverage proof'un diğer yarısı
# (deeply yapılan FATES.json'da, görmedikleri burada).
def write_skimmed_files(out_dir: Path, fates: list[FileFate]) -> Path:
    """The list of files PoC did NOT analyze deeply — gap visibility."""
    skimmed = [f for f in fates if f.fate == "read_skimmed"]
    skipped = [f for f in fates if f.fate == "skipped_with_reason"]
    lines = [f"# Files NOT deeply analyzed by PoC ({len(skimmed) + len(skipped)} total)\n\n"]
    lines.append(f"## read_skimmed ({len(skimmed)})\n\n")
    lines.append("_Files visited but no specialized adapter applied. Mechanical analysis incomplete on these._\n\n")
    for f in skimmed[:200]:
        lines.append(f"- `{f.path}` — {f.reason}\n")
    if len(skimmed) > 200:
        lines.append(f"- ... ({len(skimmed) - 200} more)\n")
    lines.append(f"\n## skipped_with_reason ({len(skipped)})\n\n")
    for f in skipped[:50]:
        lines.append(f"- `{f.path}` — {f.reason}\n")
    if len(skipped) > 50:
        lines.append(f"- ... ({len(skipped) - 50} more)\n")
    out = out_dir / "SKIMMED_FILES.md"
    out.write_text("".join(lines), encoding="utf-8")
    return out


# ─── write_git_reconciliation ────────────────────────────────────────────
# filesystem walk'ı git ls-files ile karşılaştırır. İki yön:
#   in_git_but_not_walked: tracked ama EXCLUDED_DIRS'da (örn. tracked
#     dist/ veya .nx/ artefakt'ları) — Discovery engine bunları
#     bilerek atlıyor.
#   walked_but_not_in_git: untracked / yeni / gitignored — operatör'ün
#     henüz commit etmediği dosyalar.
# Önceki sürüm bu farkı sessiz geçiyordu (saklı blind spot).
def write_git_reconciliation(out_dir: Path, fates: list[FileFate],
                             git_set: set[str]) -> tuple[Path, dict]:
    """Explain the gap between filesystem walk and git ls-files."""
    walked = {f.path for f in fates}
    in_git_not_walked = sorted(git_set - walked)
    walked_not_in_git = sorted(walked - git_set)
    summary = {
        "filesystem_walked": len(walked),
        "git_tracked": len(git_set),
        "in_git_but_not_walked": len(in_git_not_walked),
        "walked_but_not_in_git": len(walked_not_in_git),
        "in_git_but_not_walked_samples": in_git_not_walked[:50],
        "walked_but_not_in_git_samples": walked_not_in_git[:50],
        "gap_explanation": (
            "in_git_but_not_walked: tracked files inside an EXCLUDED_DIRS path "
            "(e.g. tracked dist/ artefacts, .nx/ cache files) — Discovery "
            "engine excludes these by design.  "
            "walked_but_not_in_git: untracked files (new, gitignored, or local-only)."
        ),
    }
    out = out_dir / "GIT_RECONCILIATION.json"
    out.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return out, summary


# ─── scan_prior_audits ───────────────────────────────────────────────────
# Her drift adayı için, drift'in TS+SQL enum adlarını
# docs/audits/, docs/reviews/, docs/product-audits/ altında grep'ler.
# Eşleşme varsa: bu drift zaten geçmiş audit'lerde kayıt — operatör
# biliyor olabilir. Tekrar gürültüyü filtrelemek için. PoC %100
# mekanik (keyword-only); full ARIA bunu structural compare yapacak.
def scan_prior_audits(repo_root: Path, drifts: list[dict]) -> dict[str, list[str]]:
    """For each drift, scan docs/{audits,reviews,product-audits}/ for mention
    of the enum names. Mechanical grep — no LLM. Returns {drift_concept: [audit_refs]}.
    """
    audit_roots = [
        repo_root / "docs" / "audits",
        repo_root / "docs" / "reviews",
        repo_root / "docs" / "product-audits",
    ]
    audit_files: list[Path] = []
    for root in audit_roots:
        if root.exists():
            audit_files.extend(p for p in root.rglob("*.md") if p.is_file())

    mentions: dict[str, list[str]] = {}
    for drift in drifts:
        names = {drift["ts"]["name"], drift["sql"]["name"]}
        hits: list[str] = []
        for af in audit_files:
            try:
                text = af.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for name in names:
                if name in text:
                    rel = af.relative_to(repo_root)
                    line_num = text[: text.find(name)].count("\n") + 1
                    hits.append(f"{rel}:{line_num} ({name})")
                    break  # one hit per audit file is enough signal
        if hits:
            mentions[drift["concept"] + ":" + drift["ts"]["ref"]] = hits[:5]
    return mentions


def drift_key(drift: dict) -> str:
    if drift.get("claim_type") == "frontend_dropdown_drift":
        return drift["concept"] + ":" + drift["ui"]["ref"]
    return drift["concept"] + ":" + drift["ts"]["ref"]


def parse_ref(ref: str) -> tuple[str, int] | None:
    path, sep, line = ref.rpartition(":")
    if not sep:
        return None
    try:
        return path, int(line)
    except ValueError:
        return None


def git_blame_ref(repo_root: Path, ref: str) -> dict:
    parsed = parse_ref(ref)
    if not parsed:
        return {"available": False, "reason": "ref_without_line"}
    path, line = parsed
    if not (repo_root / path).exists():
        return {"available": False, "reason": "file_missing"}
    try:
        r = subprocess.run(
            ["git", "-C", str(repo_root), "blame", "-L", f"{line},{line}", "--porcelain", "--", path],
            capture_output=True, text=True, check=True, timeout=30,
        )
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired) as exc:
        return {"available": False, "reason": exc.__class__.__name__}
    lines = r.stdout.splitlines()
    if not lines:
        return {"available": False, "reason": "empty_blame"}
    first = lines[0].split()
    sha = first[0] if first else ""
    meta: dict[str, str | bool] = {"available": True, "commit": sha}
    for line_text in lines[1:]:
        if line_text.startswith("author-time "):
            try:
                ts = int(line_text.split(" ", 1)[1])
                meta["author_date"] = datetime.fromtimestamp(ts, timezone.utc).date().isoformat()
            except ValueError:
                pass
        elif line_text.startswith("summary "):
            meta["summary"] = line_text.split(" ", 1)[1]
    return meta


def attach_git_blame(repo_root: Path, drifts: list[dict]) -> None:
    for drift in drifts:
        if drift.get("claim_type") == "frontend_dropdown_drift":
            drift["git_blame"] = {
                "ui": git_blame_ref(repo_root, drift["ui"]["ref"]),
                "source": git_blame_ref(repo_root, drift["source"]["ref"]),
            }
        else:
            drift["git_blame"] = {
                "ts": git_blame_ref(repo_root, drift["ts"]["ref"]),
                "sql": git_blame_ref(repo_root, drift["sql"]["ref"]),
            }


def scan_existing_gate_refs(repo_root: Path, drifts: list[dict]) -> dict[str, list[str]]:
    roots = [
        repo_root / "tests" / "invariants",
        repo_root / "e2e" / "tests",
        repo_root / ".github" / "workflows",
    ]
    gate_files: list[Path] = []
    for root in roots:
        if root.exists():
            gate_files.extend(
                p for p in root.rglob("*")
                if p.is_file() and p.suffix.lower() in {".ts", ".tsx", ".js", ".yml", ".yaml", ".md"}
            )

    refs: dict[str, list[str]] = {}
    for drift in drifts:
        if drift.get("claim_type") == "frontend_dropdown_drift":
            names = {
                drift["concept"],
                drift["ui"]["name"],
                drift["source"]["name"],
            }
        else:
            names = {
                drift["concept"],
                drift["ts"]["name"],
                drift["sql"]["name"],
            }
        needles = set()
        for name in names:
            normalized = normalize_concept_name(name)
            tokens = concept_tokens(name)
            if len(name) >= 6 and (any(c.isupper() for c in name) or "_" in name or "-" in name):
                needles.add(name)
            if len(normalized) >= 8:
                needles.add(normalized)
            if len(tokens - GENERIC_CONCEPT_TOKENS) >= 2:
                needles.add(" ".join(sorted(tokens - GENERIC_CONCEPT_TOKENS)))
        hits: list[str] = []
        for gf in gate_files:
            try:
                text = gf.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            lower_text = text.lower()
            for needle in sorted(needles, key=len, reverse=True):
                idx = lower_text.find(needle.lower())
                if idx == -1:
                    continue
                rel = gf.relative_to(repo_root)
                line_num = text[:idx].count("\n") + 1
                hits.append(f"{rel}:{line_num} ({needle})")
                break
            if len(hits) >= 5:
                break
        if hits:
            refs[drift_key(drift)] = hits
            drift["existing_gate_refs"] = hits
        else:
            drift["existing_gate_refs"] = []
    return refs


def build_summary(value_sets: list[dict], ui_option_groups: list[dict],
                  drifts_above: list[dict], frontend_dropdown_drifts: list[dict],
                  audit_mentions: dict[str, list[str]]) -> dict:
    ui_promotions = Counter(g.get("promotion_reason", "unknown") for g in ui_option_groups)
    ui_status = Counter(g.get("promotion_status", "unknown") for g in ui_option_groups)
    all_drifts = [*drifts_above, *frontend_dropdown_drifts]
    prior_mentioned = sum(1 for d in all_drifts if drift_key(d) in audit_mentions)
    gate_referenced = sum(1 for d in all_drifts if d.get("existing_gate_refs"))
    novel = sum(
        1 for d in all_drifts
        if drift_key(d) not in audit_mentions and not d.get("existing_gate_refs")
    )
    return {
        "value_set_counts_by_kind": dict(Counter(v.get("kind", "unknown") for v in value_sets)),
        "ui_promotion_counts": {
            "by_status": dict(ui_status),
            "by_reason": dict(ui_promotions),
        },
        "novelty_counts": {
            "total_candidates": len(all_drifts),
            "prior_audit_mentioned": prior_mentioned,
            "existing_gate_referenced": gate_referenced,
            "new_looking": novel,
        },
    }


# ─── write_report ────────────────────────────────────────────────────────
# Operatöre gidecek tek dosya: aria-poc-report.md. Coverage Invariant +
# Repository Fingerprint + TRUSTED priors + drift candidates (above
# Jaccard threshold, cross-service flagged, prior-audit mention'lı) +
# 4 soruluk decision gate. Drift listesi top 10 ile sınırlı (full
# data MECHANICAL_DRIFTS.json'da). LLM yok, opinion yok — operatör
# karar verir.
def write_report(out_dir: Path, fp: Fingerprint, fates: list[FileFate],
                 ts_value_sets: list[dict], ui_option_groups: list[dict],
                 drifts_above: list[dict], drifts_filtered: list[dict],
                 frontend_dropdown_drifts: list[dict], git_recon: dict,
                 audit_mentions: dict[str, list[str]], summary: dict,
                 artifacts: list[str]) -> Path:
    skipped = sum(1 for f in fates if f.fate == "skipped_with_reason")
    deeply = sum(1 for f in fates if f.fate == "read_deeply")
    skim = sum(1 for f in fates if f.fate == "read_skimmed")
    cross_count = sum(1 for d in drifts_above if d.get("cross_service"))
    r: list[str] = []
    r.append("# ARIA Phase-1 PoC Report\n\n")
    r.append(f"**Captured:** {fp.captured_at}  \n")
    r.append(f"**Repo:** `{fp.repo_root}`  \n")
    r.append("**LLM calls:** 0  \n")
    r.append("**Network calls:** 0 (except optional `npx nx graph` subprocess)\n\n---\n\n")

    r.append("## 1. Coverage Invariant\n\n")
    r.append(f"- Files visited: {len(fates)}\n")
    r.append(f"  - read_deeply: {deeply}\n")
    r.append(f"  - read_skimmed: {skim} (see `SKIMMED_FILES.md` for list)\n")
    r.append(f"  - skipped_with_reason: {skipped}\n")
    r.append(f"- Per-file fate ledger: `FATES.json`\n")
    r.append(f"- Coverage Invariant: {'PASS' if len(fates) > 0 else 'FAIL'} (every file has a fate)\n\n")

    r.append("### 1.1 Git ↔ Filesystem reconciliation\n\n")
    r.append(f"- Filesystem walked: {git_recon['filesystem_walked']}\n")
    r.append(f"- Git tracked: {git_recon['git_tracked']}\n")
    r.append(f"- In git but not walked: {git_recon['in_git_but_not_walked']} (excluded-dir files; see `GIT_RECONCILIATION.json`)\n")
    r.append(f"- Walked but not in git: {git_recon['walked_but_not_in_git']} (untracked / new / gitignored)\n\n")

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

    value_set_counts = summary.get("value_set_counts_by_kind", {})
    r.append("## 4. Mechanical Drift Scan (TS value sets vs SQL `CREATE TYPE ... AS ENUM`)\n\n")
    r.append(f"- TS/schema value sets scanned: {len(ts_value_sets)} — `{value_set_counts}`\n")
    r.append(f"- UI option groups recorded: {len(ui_option_groups)} (reported separately; high-confidence promotion only)\n")
    r.append(f"- **{len(drifts_above)} drift candidate(s) above Jaccard 0.3 threshold** "
             f"(of which {cross_count} are CROSS-SERVICE — categorically more critical)\n")
    r.append(f"- {len(drifts_filtered)} candidate(s) filtered out as likely false-positive name collisions "
             "(below similarity threshold; full list in `MECHANICAL_DRIFTS.json`)\n\n")
    if drifts_above:
        r.append("Each above-threshold drift requires manual verification (Nuance Discrimination Protocol per IDENTITY §3.5).\n\n")
        for i, d in enumerate(drifts_above[:10], 1):
            badge = "CROSS-SERVICE" if d.get("cross_service") else "same-service"
            r.append(f"### Drift {i}: `{d['concept']}` — {badge} (similarity {d['value_jaccard_similarity']})\n\n")
            r.append(f"- TS {d['ts'].get('kind', 'enum')} `{d['ts']['name']}` @ `{d['ts']['ref']}` "
                     f"({d.get('ts_service','?')}) — values: `{d['ts']['values']}`\n")
            r.append(f"- SQL `{d['sql']['name']}` @ `{d['sql']['ref']}` "
                     f"({d.get('sql_service','?')}) — values: `{d['sql']['values']}`\n")
            if d["missing_in_ts"]:
                r.append(f"- Missing in TS: `{d['missing_in_ts']}`\n")
            if d["missing_in_sql"]:
                r.append(f"- Missing in SQL: `{d['missing_in_sql']}`\n")
            mention_key = d["concept"] + ":" + d["ts"]["ref"]
            if mention_key in audit_mentions:
                r.append("- Prior audit mentions:\n")
                for ref in audit_mentions[mention_key]:
                    r.append(f"  - `{ref}`\n")
            else:
                r.append("- No mention in `docs/audits|reviews|product-audits` — appears to be NEW signal\n")
            if d.get("existing_gate_refs"):
                r.append("- Existing gate/test refs:\n")
                for ref in d["existing_gate_refs"]:
                    r.append(f"  - `{ref}`\n")
            if d.get("git_blame"):
                r.append(f"- Git blame: `{d['git_blame']}`\n")
            r.append("\n")
    else:
        r.append("No above-threshold drift candidates detected.\n\n")
        r.append("**Absence claim discipline (per SPEC §7.2 Rule B):**\n")
        r.append("- Heuristic matched TS `enum`, TS string-literal `type` unions, and SQL `CREATE TYPE ... AS ENUM`.\n")
        r.append("- It also scans TS `as const` arrays, Zod `z.enum([...])`, and GraphQL SDL enums.\n")
        r.append("- Frontend select/dropdown options are recorded separately and promoted only with confidence gates.\n")
        r.append("- Dynamic frontend option providers are still not traced.\n")
        r.append("- Confidence cap on absence claim: 0.7.\n\n")

    r.append("## 5. UI Option Group Scan (high-confidence candidates only)\n\n")
    r.append(f"- UI option groups recorded: {len(ui_option_groups)}\n")
    r.append(f"- Frontend dropdown drift candidate(s): {len(frontend_dropdown_drifts)}\n\n")
    promotion_counts = summary.get("ui_promotion_counts", {})
    if promotion_counts:
        r.append(f"- Promotion counts: `{promotion_counts}`\n\n")
    if frontend_dropdown_drifts:
        for i, d in enumerate(frontend_dropdown_drifts[:10], 1):
            badge = "CROSS-SERVICE" if d.get("cross_service") else "same-service"
            r.append(f"### UI Drift {i}: `{d['concept']}` — {badge} (similarity {d['value_jaccard_similarity']})\n\n")
            r.append(f"- UI `{d['ui']['name']}` @ `{d['ui']['ref']}` "
                     f"({d.get('ui_service','?')}) — values: `{d['ui']['values']}`\n")
            r.append(f"- Source {d['source_kind']} `{d['source']['name']}` @ `{d['source']['ref']}` "
                     f"({d.get('source_service','?')}) — values: `{d['source']['values']}`\n")
            if d["missing_in_ui"]:
                r.append(f"- Missing in UI: `{d['missing_in_ui']}`\n")
            if d["missing_in_source"]:
                r.append(f"- Missing in source: `{d['missing_in_source']}`\n")
            r.append(f"- Relationship: `{d.get('relationship', 'unknown')}`\n")
            if d.get("existing_gate_refs"):
                r.append("- Existing gate/test refs:\n")
                for ref in d["existing_gate_refs"]:
                    r.append(f"  - `{ref}`\n")
            if d.get("git_blame"):
                r.append(f"- Git blame: `{d['git_blame']}`\n")
            r.append("- Manual verification required before treating this as a finding.\n\n")
    else:
        r.append("No high-confidence UI dropdown drift candidates detected.\n\n")

    r.append("## 5.1 Decision Evidence Summary\n\n")
    r.append(f"- Novelty counts: `{summary.get('novelty_counts', {})}`\n")
    r.append("- Raw `ui_option_groups` include `promotion_status`, `promotion_reason`, and `nearest_value_sets` in `MECHANICAL_DRIFTS.json`.\n\n")

    r.append("## 6. Operator Decision Gate\n\n")
    r.append("Answer YES/NO to each (per CONTRACTS §13):\n\n")
    r.append("1. Did the fingerprint reveal anything you did not already know? `[ ]`\n")
    r.append("2. Did the mechanical drift scan surface real drift not caught by existing specialized agents on PR cycles? `[ ]`\n")
    r.append("3. Is the value surface of (2) large enough to justify months of kernel work? `[ ]`\n")
    r.append("4. Is the LLM cost (Claude Code session-based, NOT direct API — see CONTRACTS §0.6) within scope? `[ ]`\n\n")
    r.append("**If 3 of 4 are NO:** archive SPEC/IDENTITY/CONTRACTS as research artifacts. Existing agents + Nx + CI cover the value surface.  \n")
    r.append("**If 3 of 4 are YES:** proceed to Phase 0 — kernel skeleton (orchestrator state machine + Discovery + Memory + budget gate + kill switch + integrity hash chain). No skills yet.\n\n")
    r.append("---\n\n")
    r.append("_Generated by `tools/aria-poc/poc.py` (no LLM, no API)._  \n")
    digest = hashlib.sha256(repr(fp).encode()).hexdigest()[:16]
    r.append(f"_Fingerprint SHA-256 (first 16):_ `{digest}`\n")
    out = out_dir / "aria-poc-report.md"
    out.write_text("".join(r), encoding="utf-8")
    return out


# ─── main ────────────────────────────────────────────────────────────────
# Phase 1-7 orkestrasyon:
#   1. filesystem walk + git ls-files
#   2. fates assignment + diske yazımı (FATES.json + SKIMMED_FILES.md)
#   2.5 git ↔ filesystem reconciliation
#   3. fingerprint compute + REPO_FINGERPRINT.json
#   4. TRUSTED prior ingestion (CLAUDE.md, ADR'ler, agent index)
#   5. nx graph (best-effort)
#   6. mechanical drift scan (TS enum/union vs SQL enum + UI options)
#   6.5 prior-audit mention scan
#   7. INDEX.json manifest + aria-poc-report.md
# Exit code: 0 if drift sayısı ≤ --fail-on-drifts; aksi halde 1
# (CI integration için). Disiplinli sonlanma.
def main() -> int:
    ap = argparse.ArgumentParser(description="ARIA Phase-1 PoC — operator decision tool")
    ap.add_argument("--workspace-root", default=".", help="Repo root (default: cwd)")
    ap.add_argument("--out-dir", default=".aria-poc", help="Output dir relative to repo root")
    ap.add_argument("--skip-nx-graph", action="store_true", help="Skip nx graph subprocess call")
    ap.add_argument("--jaccard-threshold", type=float, default=0.3,
                    help="Drift name-match must exceed this value-set Jaccard similarity (default: 0.3)")
    ap.add_argument("--fail-on-drifts", type=int, default=0,
                    help="Exit code 1 when above-threshold drifts > N (default: 0 = fail on any drift). "
                         "Set very high to disable CI-fail behaviour.")
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

    print("[aria-poc] phase 2: assigning fates + persisting fates ledger...")
    fates = [assign_fate(p, repo_root) for p in files]
    write_fates_json(out_dir, fates)
    write_skimmed_files(out_dir, fates)

    print("[aria-poc] phase 2.5: git ↔ filesystem reconciliation...")
    _, git_recon = write_git_reconciliation(out_dir, fates, git_set)
    print(f"[aria-poc]   in_git_not_walked={git_recon['in_git_but_not_walked']}; "
          f"walked_not_in_git={git_recon['walked_but_not_in_git']}")

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
    ts_unions = detect_ts_union_types(repo_root, fates)
    ts_const_arrays = detect_ts_const_arrays(repo_root, fates)
    zod_enums = detect_zod_enums(repo_root, fates)
    graphql_enums = detect_graphql_enums(repo_root, fates)
    rust_enums = detect_rust_enums(repo_root, fates)
    ts_value_sets = [*ts_enums, *ts_unions, *ts_const_arrays, *zod_enums, *graphql_enums, *rust_enums]
    sql_enums = detect_sql_enums(repo_root, fates)
    ui_option_groups = detect_ui_option_groups(repo_root, fates)
    print(f"[aria-poc]   ts enums: {len(ts_enums)}; ts unions: {len(ts_unions)}; "
          f"const arrays: {len(ts_const_arrays)}; zod enums: {len(zod_enums)}; "
          f"graphql enums: {len(graphql_enums)}; rust enums: {len(rust_enums)}; "
          f"sql enums: {len(sql_enums)}; ui option groups: {len(ui_option_groups)}")
    drifts_above, drifts_filtered = find_drifts(ts_value_sets, sql_enums, args.jaccard_threshold)
    ui_option_groups, frontend_dropdown_drifts = annotate_ui_option_groups(
        ts_value_sets, sql_enums, ui_option_groups, max(args.jaccard_threshold, 0.5),
    )
    cross = sum(1 for d in drifts_above if d["cross_service"])
    print(f"[aria-poc]   above-threshold drifts: {len(drifts_above)} (cross-service: {cross}); "
          f"filtered (low similarity): {len(drifts_filtered)}")
    print(f"[aria-poc]   frontend dropdown drifts: {len(frontend_dropdown_drifts)}")

    print("[aria-poc] phase 6.5: scanning prior audit findings...")
    all_candidate_drifts = [*drifts_above, *frontend_dropdown_drifts]
    audit_mentions = scan_prior_audits(repo_root, drifts_above)
    existing_gate_refs = scan_existing_gate_refs(repo_root, all_candidate_drifts)
    attach_git_blame(repo_root, all_candidate_drifts)
    summary = build_summary(ts_value_sets, ui_option_groups, drifts_above,
                            frontend_dropdown_drifts, audit_mentions)
    print(f"[aria-poc]   drifts mentioned in prior audits: {len(audit_mentions)}")
    print(f"[aria-poc]   drifts referenced by existing gates/tests: {len(existing_gate_refs)}")

    (out_dir / "MECHANICAL_DRIFTS.json").write_text(
        json.dumps({
            "ts_enums": ts_enums,
            "ts_unions": ts_unions,
            "ts_const_arrays": ts_const_arrays,
            "zod_enums": zod_enums,
            "graphql_enums": graphql_enums,
            "ts_value_sets": ts_value_sets,
            "value_sets": [*ts_value_sets, *sql_enums],
            "sql_enums": sql_enums,
            "ui_option_groups": ui_option_groups,
            "drifts_above_threshold": drifts_above,
            "drifts_filtered_below_threshold": drifts_filtered,
            "frontend_dropdown_drifts": frontend_dropdown_drifts,
            "jaccard_threshold": args.jaccard_threshold,
            "prior_audit_mentions": audit_mentions,
            "existing_gate_refs": existing_gate_refs,
            "summary": summary,
        }, indent=2),
        encoding="utf-8",
    )

    # INDEX.json — manifest of generated artifacts (closes eksik #10)
    artifacts_disk = sorted(p for p in out_dir.iterdir() if p.is_file())
    (out_dir / "INDEX.json").write_text(
        json.dumps({
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "artifacts": [
                {
                    "name": p.name,
                    "size_bytes": p.stat().st_size,
                    "sha256_first16": hashlib.sha256(p.read_bytes()).hexdigest()[:16],
                }
                for p in artifacts_disk
                if p.name != "INDEX.json"
            ],
        }, indent=2),
        encoding="utf-8",
    )

    print("[aria-poc] phase 7: writing report...")
    report = write_report(out_dir, fp, fates, ts_value_sets, ui_option_groups,
                          drifts_above, drifts_filtered, frontend_dropdown_drifts,
                          git_recon, audit_mentions, summary, artifacts)
    print(f"[aria-poc] DONE. Report: {report}")

    # Exit code discipline: above-threshold drifts > fail-on-drifts → exit 1
    if len(drifts_above) > args.fail_on_drifts:
        print(f"[aria-poc] EXIT 1: {len(drifts_above)} above-threshold drift(s) "
              f"exceed --fail-on-drifts={args.fail_on_drifts}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
