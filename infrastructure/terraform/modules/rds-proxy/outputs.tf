# =============================================================================
# Aquaculture Platform - RDS Proxy Module Outputs
# =============================================================================

output "endpoint" {
  description = "Proxy endpoint hostname. Replaces the direct RDS endpoint in the workload's DATABASE_HOST / DATABASE_URL configuration."
  value       = aws_db_proxy.this.endpoint
}

output "arn" {
  description = "Proxy ARN. Useful for cross-account allow-lists or alarm subjects."
  value       = aws_db_proxy.this.arn
}

output "name" {
  description = "Proxy name (matches var.identifier). Useful for CloudWatch alarm dimensions."
  value       = aws_db_proxy.this.name
}

output "security_group_id" {
  description = "Proxy security group ID. Pass to a workload security-group rule that egresses to this SG (the proxy's own ingress rule allows the workload SG already)."
  value       = aws_security_group.proxy.id
}

output "iam_role_arn" {
  description = "ARN of the IAM role the proxy assumes to read the master secret. Surface for audit and for cross-region replication."
  value       = aws_iam_role.proxy.arn
}

output "log_group_name" {
  description = "CloudWatch log group name for proxy logs. Wire as a destination for log-based alarms (`Pinned*`, `BackendConnectionsClosed`, etc.)."
  value       = aws_cloudwatch_log_group.proxy.name
}
