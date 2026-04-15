# =============================================================================
# Aquaculture Platform - Production Variables
# =============================================================================

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "eu-west-1"
}

# SEC-001 fix: removed insecure default ["0.0.0.0/0"]. No default is set so the
# variable must be supplied explicitly (via TF_VAR_allowed_cidrs secret in CI/CD
# or a production.tfvars file). A validation block prevents 0.0.0.0/0 from
# being passed accidentally.
variable "allowed_cidrs" {
  description = "CIDR blocks allowed to access the EKS API server. Must not include 0.0.0.0/0."
  type        = list(string)

  validation {
    condition     = !contains(var.allowed_cidrs, "0.0.0.0/0")
    error_message = "Production EKS API must not be accessible from 0.0.0.0/0. Provide specific CIDR blocks (NAT gateway IPs, CI/CD runner IPs, or approved admin egress CIDRs)."
  }

  validation {
    condition     = length(var.allowed_cidrs) > 0
    error_message = "At least one CIDR block must be specified for EKS API access."
  }
}

# INFRA-DB-POOL-001 / Track B: shelf-ready gate for the RDS Proxy module.
# Default false — terraform plan today is unchanged. Flip to true ONLY when
# the EKS workload SG exists and the docs/runbooks/database-capacity.md
# Track B procedure has been read end-to-end.
variable "enable_rds_proxy" {
  description = "When true, provision RDS Proxy in front of the RDS instance and update workload-facing outputs to point at the proxy endpoint. Default false — gate stays off until the K8s migration."
  type        = bool
  default     = false
}
