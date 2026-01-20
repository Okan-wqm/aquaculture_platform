# =============================================================================
# Aquaculture Platform - RDS Module Outputs
# =============================================================================

output "instance_id" {
  description = "RDS instance ID"
  value       = aws_db_instance.main.id
}

output "instance_arn" {
  description = "RDS instance ARN"
  value       = aws_db_instance.main.arn
}

output "endpoint" {
  description = "RDS endpoint"
  value       = aws_db_instance.main.endpoint
}

output "address" {
  description = "RDS address (hostname)"
  value       = aws_db_instance.main.address
}

output "port" {
  description = "RDS port"
  value       = aws_db_instance.main.port
}

output "database_name" {
  description = "Database name"
  value       = aws_db_instance.main.db_name
}

output "security_group_id" {
  description = "RDS security group ID"
  value       = aws_security_group.rds.id
}

output "secret_arn" {
  description = "Secrets Manager secret ARN"
  value       = aws_secretsmanager_secret.rds.arn
}

output "connection_url" {
  description = "Database connection URL"
  value       = "postgres://${var.master_username}@${aws_db_instance.main.address}:${aws_db_instance.main.port}/${var.database_name}"
  sensitive   = true
}
