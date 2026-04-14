# Verification Log — Security Hardening Remediation

Append-only execution log. Each entry:
`{ISO8601} — Package {NN-slug} — {PASS|FAIL} — exit:{N} — commit:{hash|N/A} — notes`

---

2026-04-14T04:50:00Z — Package 01-jwt-deployment-contract — PASS — exit:0 — commit:5b786e7f — docker compose -f docker-compose.prod.yml config and docker-compose.droplet.yml config both render; YAML parse OK on all three helm values files; generate-jwt-keypair.sh script created (chmod 755)
2026-04-14T05:20:00Z — Package 02-nats-per-service-credentials — PASS — exit:0 — commit:d7ecb9d6 — both prod compose files render with per-service NATS_<SERVICE>_USER/PASS env; helm templates _helpers.tpl defines natsServiceEnv helper; secrets.yaml lists all 10 per-service user/pass keys in both inline and ExternalSecret paths
2026-04-14T05:35:00Z — Package 03-nats-mtls-enforcement — PASS — exit:0 — commit:a265eeef — generate-internal-certs.sh --force creates client-cert.pem / client-key.pem; both prod composes render with NATS_TLS_CERT/KEY wired; nats.js factory accepts new TLS cert/key; scoped tsc clean

