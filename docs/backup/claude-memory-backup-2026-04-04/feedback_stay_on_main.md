---
name: Always Stay on Main Branch
description: Never work in detached HEAD — always verify git branch --show-current is main before any commit
type: feedback
---

Agent'lar detached HEAD'de calisiyor ve commit'ler kayboluyor. Her agent prompt'una su kontrol eklenmeli:

**Why:** Birden fazla agent paralel calistiginda worktree conflict'leri detached HEAD'e dusuruyor. Commit'ler kayip oluyor, cherry-pick ile geri almak gerekiyor.

**How to apply:** Her agent prompt'unun basina ekle:
1. `git branch --show-current` — main degilse `git checkout main`
2. Commit oncesi tekrar `git branch --show-current` kontrolu
3. Agent'lara `isolation: "worktree"` KULLANMA — dogrudan main'de calissinlar
