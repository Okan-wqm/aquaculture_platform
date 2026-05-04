# ARIA Plan 006: Enterprise Cycle Engine

## Summary

This phase turns the governed runner into a cycle-capable ARIA kernel. It adds deterministic discovery, local memory, pressure scoring, reflection reports, proposal/research ledgers, and tamper-evident JSONL audit chains while preserving the existing no-auto-merge and no-production boundaries.

## Interfaces

- `PYTHONPATH=aria-kernel python3 -m aria_kernel bootstrap init --workspace-root .`
- `PYTHONPATH=aria-kernel python3 -m aria_kernel cycle run --workspace-root . --cycle-id <id> [--discovery-only] [--shadow-only]`
- `PYTHONPATH=aria-kernel python3 -m aria_kernel discovery run --workspace-root . --cycle-id <id>`
- `PYTHONPATH=aria-kernel python3 -m aria_kernel memory update --cycle-id <id>`
- `PYTHONPATH=aria-kernel python3 -m aria_kernel pressure run --cycle-id <id>`
- `PYTHONPATH=aria-kernel python3 -m aria_kernel reflection run --cycle-id <id>`
- `PYTHONPATH=aria-kernel python3 -m aria_kernel integrity verify`
- `PYTHONPATH=aria-kernel python3 -m aria_kernel proposal record|list`
- `PYTHONPATH=aria-kernel python3 -m aria_kernel research record-source|list-sources`

## Safety

Cycles write only ARIA artifacts under `aria-tools/`. Normal tool execution still uses the existing detect-and-quarantine runner, so repository mutation attempts quarantine the responsible tool. Research and architecture changes are proposal records only; they do not mutate application code.
