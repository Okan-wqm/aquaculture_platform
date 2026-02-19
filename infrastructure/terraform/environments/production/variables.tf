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
