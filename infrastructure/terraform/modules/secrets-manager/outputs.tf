# =============================================================================
# Aquaculture Platform - Secrets Manager Module Outputs
# =============================================================================

output "secret_arns" {
  description = "Map of short name → ARN for every provisioned secret. Consumed by the IRSA policy attached to the External Secrets Operator service account."
  value       = { for name, sec in aws_secretsmanager_secret.this : name => sec.arn }
}

output "secret_names" {
  description = "Map of short name → fully-qualified Secrets Manager name (with prefix)."
  value       = { for name, sec in aws_secretsmanager_secret.this : name => sec.name }
}

output "secret_ids" {
  description = "Map of short name → Secret ID. Useful for wiring IAM resource-based policies."
  value       = { for name, sec in aws_secretsmanager_secret.this : name => sec.id }
}
