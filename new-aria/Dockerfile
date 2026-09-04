# syntax=docker/dockerfile:1.7
# =============================================================================
# new-aria — standalone ARIA runtime image
#
# WHY: the ARIA surface is moved out of the aquaculture monorepo as-is and must
# run on its own: kernel (Python), executor + adapters (Node/ts-node), and the
# CLI tools the kernel shells out to (git, gh, claude). Nothing in this image
# reaches back into the monorepo; the tree under /opt/new-aria is the whole
# system, exactly as tracked in git.
#
# WHAT: node:22 (adapters, gates, Claude Code CLI) + Debian python3 (>=3.11,
# the kernel floor) + git + gh. Python dependencies come from
# aria-kernel/pyproject.toml — the same single source .github/actions/
# setup-aria-kernel reads — never from a list kept here.
#
# Runs as a non-root user: the Claude Code CLI refuses
# --dangerously-skip-permissions under root (ADR-040), and the kernel's
# worktree writes never need root.
# =============================================================================
FROM node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d

# Pinned to the version the aria-auto-cycle lane accepts (REQUIRED_CLAUDE_VERSION
# floor is 2.1.221; the operator droplet runs 2.1.259). Override at build time.
ARG CLAUDE_CODE_VERSION=2.1.259

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    ARIA_HOME=/opt/new-aria \
    PYTHONPATH=/opt/new-aria/aria-kernel:/opt/new-aria \
    ARIA_TOOLS_DIR=/data/aria-tools \
    ARIA_WORKSPACE_ROOT=/workspace \
    PATH=/opt/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# System layer: python (kernel), git (snapshot/evidence verification),
# gh (PR lanes), bubblewrap (the `bwrap --unshare-net` sandbox behind every
# write-capable agent spawn; needs user namespaces, so grant the container
# CAP_SYS_ADMIN or run `doctor` to see the backend refused), certificates +
# curl/gpg only to fetch the gh apt keyring.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip git ca-certificates curl gnupg bubblewrap; \
    install -d -m 0755 /usr/share/keyrings; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg; \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends gh; \
    apt-get purge -y --auto-remove curl gnupg; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /opt/new-aria

# Python dependency layer — parsed from pyproject.toml so the image and the CI
# action cannot disagree about what the kernel needs.
COPY aria-kernel/pyproject.toml aria-kernel/pyproject.toml
RUN set -eux; \
    python3 -m venv /opt/venv; \
    /opt/venv/bin/pip install --no-cache-dir --upgrade pip; \
    /opt/venv/bin/python - <<'PY'
import subprocess, sys, tomllib
from pathlib import Path
deps = tomllib.loads(Path("aria-kernel/pyproject.toml").read_text())["project"]["dependencies"]
subprocess.check_call([sys.executable, "-m", "pip", "install", "--no-cache-dir", *deps])
PY

# Node dependency layer — ts-node + typescript for adapters and gates. They are
# ALSO installed globally: the kernel runs adapters with cwd = the observed
# workspace (`npx ts-node --project tools/gates/tsconfig.json ...`), and a mounted
# workspace carries no node_modules, so npx must find the binaries on PATH or it
# reports every adapter as environment_unavailable (measured in the container
# probe). Plus the
# Claude Code CLI the executor drives. --ignore-scripts skips its postinstall, so the
# native binary is fetched explicitly by install.cjs (real mode needs a mounted login session;
# CLAUDE_CLI_MOCK=1 runs the fixture path without it).
COPY package.json ./
RUN set -eux; \
    npm install --no-audit --no-fund --ignore-scripts; \
    npm install -g --no-audit --no-fund --ignore-scripts typescript@5.9.3 ts-node@10.9.2 @types/node@20.19.9; \
    npm install -g --no-audit --no-fund --ignore-scripts "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"; \
    node "$(npm root -g)/@anthropic-ai/claude-code/install.cjs"; \
    claude --version; \
    npm cache clean --force

# The ARIA surface itself, exactly as tracked.
COPY . .

# Non-root runtime user (uid chosen outside the node image's uid 1000 `node`).
RUN set -eux; \
    useradd --create-home --uid 10001 --shell /bin/bash aria; \
    mkdir -p /data/aria-tools /data/workspaces /workspace; \
    chown -R aria:aria /opt/new-aria /data /workspace; \
    chmod +x /opt/new-aria/bin/aria /opt/new-aria/scripts/docker/smoke.sh

USER aria
VOLUME ["/data", "/workspace"]

# Every invocation is the kernel CLI; `docker run new-aria --help` lists it.
ENTRYPOINT ["/opt/new-aria/bin/aria"]
CMD ["--help"]
