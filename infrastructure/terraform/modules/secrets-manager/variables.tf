# =============================================================================
# Aquaculture Platform - Secrets Manager Module Variables
# =============================================================================
#
# INFRA-SECRETS-001: this module provisions the AWS Secrets Manager secrets
# referenced by the Helm chart's ExternalSecret templates
# (infrastructure/helm/aquaculture/values-production.yaml). It does NOT write
# secret VALUES via Terraform — values land via AWS Console/CLI after
# provisioning so the plaintext never enters the Terraform state file.

variable "name_prefix" {
  description = "Path prefix inside Secrets Manager. Keep it deterministic per environment, e.g. 'aquaculture/production'."
  type        = string
  validation {
    condition     = can(regex("^[A-Za-z0-9/_-]+$", var.name_prefix))
    error_message = "name_prefix must contain only A-Z, a-z, 0-9, slash, underscore, or hyphen."
  }
}

variable "secrets" {
  description = <<-EOT
    List of secrets to provision. Each entry is:
      name        — short name appended to name_prefix (e.g. "jwt-private-key")
      description — human-readable purpose string, surfaced in AWS Console
      rotation    — optional block: { lambda_arn, days } — if set, enables
                    scheduled rotation via the supplied Lambda. Only set for
                    DB-credential secrets with an AWS-supplied rotation Lambda
                    or a custom one. Leave null for app-level secrets (JWT
                    keypair, Stripe, password pepper) that rotate via the
                    runbook cadence enforced by the reminder workflow.
  EOT
  type = list(object({
    name        = string
    description = string
    rotation = optional(object({
      lambda_arn = string
      days       = number
    }))
  }))
  validation {
    condition     = length(var.secrets) == length(distinct([for s in var.secrets : s.name]))
    error_message = "Secret names must be unique."
  }
}

variable "kms_key_arn" {
  description = <<-EOT
    ARN of a customer-managed KMS key used to encrypt every secret in this
    module. REQUIRED in production — do not fall back to the aws/secretsmanager
    AWS-managed default because that key policy is shared across the account
    and cannot be audited per workload.
  EOT
  type        = string
}

variable "recovery_window_days" {
  description = "Soft-delete window (AWS: 7-30). Defaults to 30 — the safest value; shorten only when compliance requires faster erasure."
  type        = number
  default     = 30
  validation {
    condition     = var.recovery_window_days >= 7 && var.recovery_window_days <= 30
    error_message = "recovery_window_days must be between 7 and 30."
  }
}

variable "tags" {
  description = "Common tags applied to every secret."
  type        = map(string)
  default     = {}
}
