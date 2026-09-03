# /aria-cycle

Run one governed ARIA enterprise cycle from the repository root.

```bash
PYTHONPATH=aria-kernel python3 -m aria_kernel --tools-dir aria-tools cycle run --workspace-root . --cycle-id "$(date -u +%Y-%m-%dT%H-%M-%SZ)" --shadow-only
```

Use `--discovery-only` for the first bootstrap pass. ARIA_STOP is honored at `aria-tools/ARIA_STOP`.
