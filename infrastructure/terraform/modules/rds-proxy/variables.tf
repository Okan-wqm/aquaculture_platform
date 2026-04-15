# =============================================================================
# Aquaculture Platform - RDS Proxy Module Variables
# =============================================================================
#
# INFRA-DB-POOL-001: this module stands up an AWS RDS Proxy in front of an
# existing aws_db_instance. The proxy multiplexes many client connections
# to a smaller pool of backend connections, automatically pinning sessions
# that issue session-altering commands (SET, prepared statements, advisory
# locks, LISTEN/NOTIFY) so the platform's TenantConnectionBootstrap and
# RlsConnectionBootstrap remain correct without code change.
#
# Module is consumed only when var.enable_rds_proxy=true is set in the
# environment root module. Today (Apr 2026) every environment leaves it
# false; the module is shelf-ready for the K8s migration.

variable "identifier" {
  description = "Short identifier appended to AWS resource names. Keep ≤ 24 chars to leave room for the AWS-generated suffixes."
  type        = string
  validation {
    condition     = length(var.identifier) <= 24 && can(regex("^[a-z0-9-]+$", var.identifier))
    error_message = "identifier must be lowercase alphanumeric + hyphen, ≤24 chars."
  }
}

variable "vpc_id" {
  description = "VPC ID where the proxy will be created. Must be the same VPC as the target DB instance."
  type        = string
}

variable "subnet_ids" {
  description = "Subnet IDs (≥2 in distinct AZs) for proxy ENIs. Must be the same set as the target DB instance's subnet group."
  type        = list(string)
  validation {
    condition     = length(var.subnet_ids) >= 2
    error_message = "RDS Proxy requires ≥2 subnets in distinct AZs."
  }
}

variable "db_secret_arn" {
  description = "ARN of the Secrets Manager secret containing the master DB credentials (output `secret_arn` from the rds module). The proxy IAM role gets GetSecretValue on this exact ARN — no wildcards."
  type        = string
}

variable "db_instance_identifier" {
  description = "DB instance identifier to register as the proxy's target (output `instance_id` from the rds module)."
  type        = string
}

variable "db_security_group_id" {
  description = "Security group ID protecting the target DB. The proxy's SG will be granted ingress on this SG."
  type        = string
}

variable "allowed_security_group_id" {
  description = "Security group ID of the workloads (EKS node group / EC2) that connect to the proxy. Ingress on the proxy SG is restricted to this SG."
  type        = string
}

variable "engine_family" {
  description = "Proxy engine family — POSTGRESQL or MYSQL. Default POSTGRESQL."
  type        = string
  default     = "POSTGRESQL"
  validation {
    condition     = contains(["POSTGRESQL", "MYSQL"], var.engine_family)
    error_message = "engine_family must be POSTGRESQL or MYSQL."
  }
}

variable "require_tls" {
  description = "Require TLS for client connections. Production must be true; lower environments may set false during initial smoke test."
  type        = bool
  default     = true
}

variable "idle_client_timeout_seconds" {
  description = "Seconds before idle proxy ↔ client connection is closed. AWS default 1800 (30 min). Lower for memory-constrained workloads."
  type        = number
  default     = 1800
}

variable "max_connections_percent" {
  description = "Percentage of max_connections the proxy may use as backend connections. Default 100 (use all of them)."
  type        = number
  default     = 100
  validation {
    condition     = var.max_connections_percent > 0 && var.max_connections_percent <= 100
    error_message = "max_connections_percent must be in (0, 100]."
  }
}

variable "max_idle_connections_percent" {
  description = "Percentage of max_connections kept idle in the backend pool. Higher = lower latency on cold paths, more memory on the DB. AWS default 50."
  type        = number
  default     = 50
}

variable "connection_borrow_timeout_seconds" {
  description = "Seconds a client request waits for a backend connection before failing. Default 120 (matches AWS default). Lower for fail-fast on saturation."
  type        = number
  default     = 120
}

variable "session_pinning_filters" {
  description = "List of additional session-altering reasons that should NOT trigger pinning. Default empty — every session-altering command pins, which preserves correctness for our schema-per-tenant + RLS GUC usage."
  type        = list(string)
  default     = []
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for the proxy log group."
  type        = number
  default     = 30
}

variable "tags" {
  description = "Common tags applied to every resource."
  type        = map(string)
  default     = {}
}
