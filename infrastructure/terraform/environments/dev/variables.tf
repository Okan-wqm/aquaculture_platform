# =============================================================================
# Aquaculture Platform - Development Variables
# =============================================================================

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "eu-west-1"
}

# SEC-009 fix: explicit CIDR allowlist for dev EKS API access — no default so the
# value must be supplied explicitly (via TF_VAR_allowed_cidrs in CI/CD or a
# dev.tfvars file). Should be set to company VPN CIDR or developer egress IPs.
variable "allowed_cidrs" {
  description = "CIDR blocks allowed to access the EKS API server. Must not include 0.0.0.0/0."
  type        = list(string)

  validation {
    condition     = !contains(var.allowed_cidrs, "0.0.0.0/0")
    error_message = "EKS API must not be accessible from 0.0.0.0/0. Provide specific CIDR blocks."
  }

  validation {
    condition     = length(var.allowed_cidrs) > 0
    error_message = "At least one CIDR block must be specified for EKS API access."
  }
}
