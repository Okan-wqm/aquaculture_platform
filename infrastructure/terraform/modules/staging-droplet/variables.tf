# =============================================================================
# Aquaculture Platform — Staging Droplet Module Variables (WS9)
#
# Everything that changes between operators / tenants lives here. Secrets
# (POSTGRES_PASSWORD, INTERNAL_SERVICE_SECRET, Stripe sandbox keys, …) are
# intentionally ABSENT — they are populated via the staging-environment
# runbook's first-run seeding step, NEVER via Terraform inputs (keeps them
# out of tfstate and .tfvars).
# =============================================================================

variable "project_name" {
  description = "Short project slug used in resource names / tags (e.g. 'aquaculture')."
  type        = string
  default     = "aquaculture"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,31}$", var.project_name))
    error_message = "project_name must be 3-32 chars, lowercase alphanumeric + hyphens."
  }
}

variable "region" {
  description = "DigitalOcean droplet region slug (e.g. 'fra1', 'nyc3')."
  type        = string

  validation {
    condition = contains(
      ["nyc1", "nyc3", "ams3", "sfo2", "sfo3", "sgp1", "lon1", "fra1", "tor1", "blr1", "syd1"],
      var.region,
    )
    error_message = "region must be a valid DO region slug."
  }
}

variable "domain" {
  description = "Base domain (e.g. 'suderra.com'). Staging FQDN will be 'staging.<domain>'. The domain MUST already exist in DigitalOcean's DNS."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\\.[a-z]{2,}$", var.domain))
    error_message = "domain must be a valid FQDN (e.g. 'example.com')."
  }
}

variable "ssh_key_name" {
  description = "Name of an SSH key already registered in DigitalOcean (Account → Security → SSH keys). Terraform looks up the key ID by name — it does NOT create or store the key itself."
  type        = string
}

variable "ssh_allowed_cidrs" {
  description = "CIDR ranges permitted to reach SSH (port 22) on the staging droplet. Default denies everything; operators MUST supply their bastion / office CIDRs."
  type        = list(string)
  default     = []

  validation {
    # Allow empty list so plan succeeds with an explicit error message.
    condition     = length(var.ssh_allowed_cidrs) == 0 || alltrue([for c in var.ssh_allowed_cidrs : can(cidrnetmask(c))])
    error_message = "ssh_allowed_cidrs entries must be valid IPv4/IPv6 CIDR notation."
  }
}

variable "mqtt_allowed_cidrs" {
  description = "CIDR ranges permitted to reach mosquitto TLS (port 8883). Default 0.0.0.0/0 because edge devices are field-deployed with dynamic IPs; tighten when edge-device CIDR allocation is known."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}

variable "allow_icmp" {
  description = "Permit ICMP (ping/traceroute) from ssh_allowed_cidrs. Useful for diagnostics; default false to minimise attack surface."
  type        = bool
  default     = false
}

variable "droplet_image" {
  description = "DO droplet image slug. Must match production image family for parity (default 'ubuntu-22-04-x64' mirrors current production droplet)."
  type        = string
  default     = "ubuntu-22-04-x64"
}

variable "droplet_size" {
  description = "DO droplet size slug. Default s-2vcpu-4gb (~24 USD/mo) is the smallest size that fits the 15-container staging stack. Bump to s-4vcpu-8gb for load testing."
  type        = string
  default     = "s-2vcpu-4gb"

  validation {
    condition = contains(
      ["s-1vcpu-2gb", "s-2vcpu-2gb", "s-2vcpu-4gb", "s-4vcpu-8gb", "s-8vcpu-16gb"],
      var.droplet_size,
    )
    error_message = "droplet_size must be a validated DO slug (avoids accidental 32GB@~160USD/mo allocation)."
  }
}

variable "vpc_uuid" {
  description = "Optional VPC UUID to place the droplet in. Null = default VPC for the region. Production also uses default VPC, so staging parity is preserved with null."
  type        = string
  default     = null
}

variable "reserved_ip" {
  description = "Optional Reserved IP address already allocated in DO (e.g. '203.0.113.42'). When supplied, DNS points at this IP and the droplet rebuilds do not invalidate clients. When null, DNS points at the droplet's dynamic IPv4 (short TTL to compensate)."
  type        = string
  default     = null

  validation {
    condition     = var.reserved_ip == null || can(regex("^([0-9]{1,3}\\.){3}[0-9]{1,3}$", var.reserved_ip))
    error_message = "reserved_ip must be null or a valid IPv4 dotted-quad."
  }
}

variable "cloud_init_user_data" {
  description = "Optional cloud-init user_data script for first-boot provisioning (install docker, docker compose plugin, certbot). Runs ONCE on provision; ignored on subsequent applies. Omit to bootstrap manually via SSH per the runbook."
  type        = string
  default     = null
  sensitive   = false # This is boot-time config, not a secret — but operators should still avoid putting credentials in it.
}

variable "spaces_region" {
  description = "DO Spaces region for the backup bucket (e.g. 'fra1'). Should match droplet region to keep inter-region egress at zero."
  type        = string
}

variable "backup_retention_days" {
  description = "Days to retain staging backups in the Spaces bucket. Default 3 keeps cost tiny — staging backups are diagnostic, not DR."
  type        = number
  default     = 3

  validation {
    condition     = var.backup_retention_days >= 1 && var.backup_retention_days <= 30
    error_message = "backup_retention_days must be between 1 and 30. Staging is not a long-term archive."
  }
}
