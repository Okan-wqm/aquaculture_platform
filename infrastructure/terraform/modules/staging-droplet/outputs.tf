# =============================================================================
# Aquaculture Platform — Staging Droplet Module Outputs (WS9)
#
# What the environment root module (environments/staging/main.tf) publishes
# to the operator after a successful apply. Every output that contains
# infrastructure identity (IPs, bucket names) is surfaced so the operator
# can plug the values into the deploy-staging.yml secrets and the runbook's
# first-run seeding step.
# =============================================================================

output "droplet_id" {
  description = "DigitalOcean droplet ID — useful for `doctl compute droplet get <id>`."
  value       = digitalocean_droplet.staging.id
}

output "droplet_ipv4" {
  description = "Droplet public IPv4 address. When a Reserved IP is supplied, DNS uses that instead; this output remains the direct droplet IP for diagnostics."
  value       = digitalocean_droplet.staging.ipv4_address
}

output "droplet_ipv6" {
  description = "Droplet public IPv6 address (ipv6 = true in droplet resource)."
  value       = digitalocean_droplet.staging.ipv6_address
}

output "staging_fqdn" {
  description = "Fully qualified staging hostname (staging.<domain>). Use this in CORS_ORIGINS / FRONTEND_URL / SSH target."
  value       = "staging.${var.domain}"
}

output "spaces_bucket_name" {
  description = "Name of the DO Spaces bucket holding staging backups. Used by the backup script on the droplet."
  value       = digitalocean_spaces_bucket.staging_backups.name
}

output "spaces_bucket_endpoint" {
  description = "S3-compatible endpoint for the Spaces bucket (e.g. https://fra1.digitaloceanspaces.com). Consumed by doctl / aws cli / mc."
  value       = digitalocean_spaces_bucket.staging_backups.endpoint
}

output "spaces_bucket_region" {
  description = "Region where the Spaces bucket lives."
  value       = digitalocean_spaces_bucket.staging_backups.region
}

output "firewall_id" {
  description = "DO firewall resource ID (for audit / drift detection)."
  value       = digitalocean_firewall.staging.id
}

output "dns_record_fqdn" {
  description = "Fully qualified A record (staging.<domain>) — same as staging_fqdn, duplicated for clarity when consuming the output in downstream tooling."
  value       = digitalocean_record.staging.fqdn
}

output "project_id" {
  description = "DO project ID that groups the droplet + bucket for billing attribution."
  value       = digitalocean_project.staging.id
}

# =============================================================================
# Secrets manifest reminder — NOT a value, just a marker output so a
# `terraform output` after provision reminds the operator to seed .env via
# the runbook. This is documentation-as-output; cheap insurance against
# operators forgetting the secret-seeding step.
# =============================================================================
output "next_step_reminder" {
  description = "One-line reminder of the next operator action after provision."
  value = join(" ", [
    "Droplet provisioned. Seed staging /var/aqua-saas/.env with secrets",
    "per docs/runbooks/staging-environment.md#first-run-secret-seeding",
    "BEFORE running deploy-staging.yml.",
  ])
}
