# =============================================================================
# Aquaculture Platform - ElastiCache Module Outputs
# =============================================================================

output "replication_group_id" {
  description = "ElastiCache replication group ID"
  value       = aws_elasticache_replication_group.main.id
}

output "replication_group_arn" {
  description = "ElastiCache replication group ARN"
  value       = aws_elasticache_replication_group.main.arn
}

output "primary_endpoint" {
  description = "Primary endpoint address"
  value       = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "reader_endpoint" {
  description = "Reader endpoint address"
  value       = aws_elasticache_replication_group.main.reader_endpoint_address
}

output "port" {
  description = "Redis port"
  value       = var.port
}

output "security_group_id" {
  description = "Redis security group ID"
  value       = aws_security_group.redis.id
}

output "secret_arn" {
  description = "Secrets Manager secret ARN"
  value       = aws_secretsmanager_secret.redis.arn
}

output "connection_url" {
  description = "Redis connection URL"
  value       = var.transit_encryption_enabled ? "rediss://${aws_elasticache_replication_group.main.primary_endpoint_address}:${var.port}" : "redis://${aws_elasticache_replication_group.main.primary_endpoint_address}:${var.port}"
  sensitive   = true
}
