# =============================================================================
# Aquaculture Platform — Staging Droplet (WS9 / ADR-016 Phase D)
#
# Provisions the DigitalOcean infrastructure needed to host the staging copy
# of the aquaculture platform compose stack.
#
# RESOURCES (all production-parity-aware, intentionally smaller):
#   - digitalocean_droplet         — 2vCPU / 4GB (s-2vcpu-4gb), ~24 USD/mo
#   - digitalocean_spaces_bucket   — backup sink with 3-day lifecycle expiry
#   - digitalocean_firewall        — 443 / 22 / 8883 in; all else denied
#   - digitalocean_record          — A record staging.<domain>
#   - digitalocean_project         — resource grouping for cost attribution
#
# INPUTS MANAGED OUT-OF-BAND (operator-provided variables, NOT created here):
#   - var.ssh_key_id       — DO SSH key fingerprint; operator adds via DO UI
#                            and supplies the ID here. Terraform MUST NOT
#                            create SSH keys (state would store fingerprint
#                            but the private key lives on operator's machine).
#   - var.reserved_ip      — optional; stable public IP across destroy+recreate.
#                            Operator reserves in DO UI, supplies the IP here.
#                            When null, droplet uses its dynamic IP (fine for
#                            first provision before DNS is pointed at staging).
#   - var.domain           — base domain (e.g. "suderra.com"); staging FQDN is
#                            built as "staging.${var.domain}".
#
# DO NOT PROVISION SECRETS IN TERRAFORM STATE:
#   Staging .env values (POSTGRES_PASSWORD, INTERNAL_SERVICE_SECRET,
#   OBSERVABILITY_INTERNAL_API_KEY, Stripe sandbox keys, ...) are populated
#   out-of-band via the deploy-staging.yml workflow or the runbook's
#   first-run seeding procedure. Putting secret VALUES in .tfvars would leak
#   them into tfstate (which is encrypted but still visible to anyone with
#   read access to the state bucket). The module deliberately exposes
#   provisioning hooks (droplet / firewall / DNS) without taking custody of
#   secret values.
#
# OPERATOR PROVISION COMMAND:
#   cd infrastructure/terraform/environments/staging   # see environments/staging/main.tf
#   terraform init
#   terraform apply
#
# DESTROY / RECREATE:
#   Safe to destroy + recreate in full. Backups live in the Spaces bucket,
#   which is prevent_destroy-guarded below. DNS points at the Reserved IP
#   (when supplied) so FQDN resolution survives a droplet replacement.
# =============================================================================

# ARCH-009 parity: terraform {} block belongs to the environment root module,
# not this child module. Providers / versions are governed from environments/staging/main.tf.

locals {
  droplet_name     = "${var.project_name}-staging"
  staging_hostname = "staging.${var.domain}"
  spaces_bucket    = "${var.project_name}-staging-backups"

  common_tags = {
    Project     = var.project_name
    Environment = "staging"
    ManagedBy   = "terraform"
    Purpose     = "ws9-staging-droplet"
  }
}

# =============================================================================
# SSH Key lookup — operator supplies ID (NOT fingerprint/content).
# The data source validates the key exists in the DO account; if the operator
# supplies a stale ID the plan fails fast rather than provisioning a droplet
# with no admin access.
# =============================================================================
data "digitalocean_ssh_key" "operator" {
  name = var.ssh_key_name
}

# =============================================================================
# Staging Droplet — single-node host for the full compose stack.
#
# Size rationale (s-2vcpu-4gb @ ~24 USD/mo):
#   - Memory budget across the full compose stack after staging overrides is
#     ~3.5GB. A 4GB droplet leaves ~500MB for OS/Docker/ssh — adequate for
#     staging smoke tests but NOT for sustained load. If staging is ever used
#     for load testing, bump to s-4vcpu-8gb (matches prod size).
#   - 2 vCPU keeps parallel build/pull throughput workable during deploys.
#
# Image: ubuntu-22-04-x64 — same distro family as production droplet. Using
# the same base removes a whole class of "works in staging, fails in prod"
# bugs (systemd version, Docker repo, kernel features, etc).
#
# user_data: optional cloud-init for first-boot package installation
# (docker-ce, docker-compose-plugin, certbot). Left as var so operators can
# iterate on the bootstrap without re-plans here.
# =============================================================================
resource "digitalocean_droplet" "staging" {
  image  = var.droplet_image
  name   = local.droplet_name
  region = var.region
  size   = var.droplet_size

  ssh_keys = [data.digitalocean_ssh_key.operator.id]

  # Enable monitoring so DO captures CPU / memory / disk metrics — feeds into
  # the monitoring alert for runaway deploys.
  monitoring = true

  # VPC placement: use default VPC for the region unless operator supplied one.
  # A dedicated staging VPC would be ideal but production also uses the default,
  # so staging parity wins.
  vpc_uuid = var.vpc_uuid

  user_data = var.cloud_init_user_data

  # IPv6 on: prod has it, staging should too so IPv6-specific edge cases
  # (nginx listen directives, IPv6 egress from containers) are reproduced.
  ipv6 = true

  # Backups OFF — DO's built-in backups are coarse (weekly, full droplet).
  # We use explicit per-volume backup to Spaces via the nightly workflow.
  # Droplet-level backups would double the cost for redundant data.
  backups = false

  # resize_disk = false: if we ever change `size`, only CPU/RAM scale — the
  # disk stays at the original size (disk expansion is irreversible and the
  # default behaviour would trap us in a forced data migration).
  resize_disk = false

  tags = [
    "project:${var.project_name}",
    "environment:staging",
    "managed-by:terraform",
  ]

  lifecycle {
    # Ignore user_data changes after creation — cloud-init only runs on first
    # boot. Modifying user_data after provision forces destroy+recreate, which
    # would wipe the droplet's local state (postgres volume, certs, .env).
    # Operators re-run bootstrap steps via SSH, not via tf apply.
    ignore_changes = [user_data, image]
  }
}

# =============================================================================
# Reserved IP binding — optional, for DNS stability across droplet rebuilds.
# The Reserved IP itself is managed OUT-OF-BAND by the operator (via DO UI)
# because creating/destroying reserved IPs has direct billing implications
# and a reserved IP in tfstate introduces destroy-order hazards (DNS record
# pointing at a destroyed IP). Operator supplies var.reserved_ip; Terraform
# only manages the assignment.
# =============================================================================
resource "digitalocean_reserved_ip_assignment" "staging" {
  count = var.reserved_ip == null ? 0 : 1

  ip_address = var.reserved_ip
  droplet_id = digitalocean_droplet.staging.id
}

# =============================================================================
# DNS A record — staging.<domain>.
#
# Value strategy:
#   - When operator supplied a Reserved IP, DNS points there (stable across
#     droplet rebuilds).
#   - When not, DNS points at the droplet's dynamic ipv4_address (changes on
#     rebuild, short 300s TTL to accommodate).
# =============================================================================
resource "digitalocean_record" "staging" {
  domain = var.domain
  type   = "A"
  name   = "staging"
  value  = var.reserved_ip != null ? var.reserved_ip : digitalocean_droplet.staging.ipv4_address

  # 300s (5 min) TTL — long enough for normal request caching, short enough
  # that a droplet rebuild doesn't leave clients pinned to a dead IP for hours.
  ttl = 300
}

# =============================================================================
# Firewall — ingress allowlist. DO firewall is stateful, so egress rules
# simply permit all (outbound is not a security concern at the edge).
#
# Ingress rules:
#   443/tcp  — HTTPS (primary user traffic)
#   22/tcp   — SSH, restricted to operator CIDR list (var.ssh_allowed_cidrs)
#   8883/tcp — MQTT TLS (sensor edge devices; restrict to edge-device CIDRs
#              when known — default 0.0.0.0/0 because edge devices are
#              field-deployed with dynamic IPs)
#
# Port 80 is INTENTIONALLY CLOSED. The production droplet serves port 80
# for Let's Encrypt HTTP-01 validation; staging uses DNS-01 via
# certbot-dns-digitalocean in the cloud-init bootstrap, which requires no
# inbound port 80. This closes an attack surface.
#
# If staging operators choose HTTP-01 instead of DNS-01, add a conditional
# rule here gated on var.acme_http_01 = true.
# =============================================================================
resource "digitalocean_firewall" "staging" {
  name = "${local.droplet_name}-fw"

  droplet_ids = [digitalocean_droplet.staging.id]

  # ── Inbound ──────────────────────────────────────────────────────────────
  inbound_rule {
    protocol         = "tcp"
    port_range       = "443"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = var.ssh_allowed_cidrs
  }

  inbound_rule {
    protocol         = "tcp"
    port_range       = "8883"
    source_addresses = var.mqtt_allowed_cidrs
  }

  # ICMP for traceroute / ping — disabled by default; enable via var if
  # operator needs diagnostic access.
  dynamic "inbound_rule" {
    for_each = var.allow_icmp ? [1] : []
    content {
      protocol         = "icmp"
      source_addresses = var.ssh_allowed_cidrs
    }
  }

  # ── Outbound ─────────────────────────────────────────────────────────────
  # Permit all outbound — the droplet needs to pull container images from
  # ghcr.io, fetch Let's Encrypt certs, call Stripe sandbox, and send email.
  # DO firewall is stateful so response traffic is implicit.
  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}

# =============================================================================
# Spaces bucket — staging backup sink.
#
# Retention: 3-day lifecycle expiry. Staging does NOT need 30-day recovery
# (the data is synthetic / smoke-test). If a staging backup matters for
# diagnostics, operator copies it to a long-term bucket out of band.
#
# Security: force_destroy = false so a `terraform destroy` does NOT silently
# wipe backup history. Versioning ON so a buggy backup script cannot corrupt
# the restore path. Public access blocked at creation.
#
# Region: default matches droplet region for latency + egress-free cost.
# =============================================================================
resource "digitalocean_spaces_bucket" "staging_backups" {
  name   = local.spaces_bucket
  region = var.spaces_region
  acl    = "private"

  versioning {
    enabled = true
  }

  lifecycle_rule {
    id      = "expire-staging-backups"
    enabled = true

    expiration {
      days = var.backup_retention_days
    }

    noncurrent_version_expiration {
      days = var.backup_retention_days
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

# =============================================================================
# Project — logical grouping for DO's billing dashboard / resource view.
# =============================================================================
resource "digitalocean_project" "staging" {
  name        = "${var.project_name}-staging"
  description = "Aquaculture Platform — staging environment (ADR-016 Phase D)"
  purpose     = "Web Application"
  environment = "Staging"

  resources = compact([
    digitalocean_droplet.staging.urn,
    digitalocean_spaces_bucket.staging_backups.urn,
  ])
}
