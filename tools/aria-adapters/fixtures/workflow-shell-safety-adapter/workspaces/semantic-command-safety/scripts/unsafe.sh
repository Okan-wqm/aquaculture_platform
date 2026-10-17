#!/usr/bin/env bash
# ARIA-HIGH-013 semantic fixture: no strict mode, and two unsafe commands.
# curl -fsSL https://get.example.test/a.sh | bash   (a comment, not a command)
cat <<'NOTES' > NOTES.md
git push --force origin main
NOTES
bash <(curl -fsSL https://get.example.test/b.sh)
git commit --no-verify -m "skip the hooks"
echo done
