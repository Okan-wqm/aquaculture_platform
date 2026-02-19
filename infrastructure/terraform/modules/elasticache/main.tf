# =============================================================================
# Aquaculture Platform - ElastiCache Module (Redis)
# =============================================================================

# ARCH-009 fix: removed terraform {} block from child module — provider constraints
# are advisory only in child modules; the environment root module governs versions.

# =============================================================================
# Auth Token
# SEC-022 fix: special = true with safe override_special. Characters excluded are
# those that break Redis connection string or AUTH command parsing (@ / : space).
# =============================================================================

resource "random_password" "auth_token" {
  count            = var.transit_encryption_enabled && var.auth_token == "" ? 1 : 0
  length           = 64
  special          = true
  override_special = "!$%^&*()-_=+[]{}<>"
}

locals {
  auth_token = var.transit_encryption_enabled ? (var.auth_token != "" ? var.auth_token : random_password.auth_token[0].result) : null
}

# =============================================================================
# Security Group
# =============================================================================

resource "aws_security_group" "redis" {
  name_prefix = "${var.cluster_id}-redis-"
  description = "Security group for ElastiCache Redis"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, {
    Name = "${var.cluster_id}-redis-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group_rule" "redis_ingress" {
  type                     = "ingress"
  from_port                = var.port
  to_port                  = var.port
  protocol                 = "tcp"
  source_security_group_id = var.allowed_security_group_id
  security_group_id        = aws_security_group.redis.id
}

# =============================================================================
# Parameter Group
# =============================================================================

resource "aws_elasticache_parameter_group" "main" {
  name   = "${var.cluster_id}-params"
  family = "redis${split(".", var.engine_version)[0]}"

  dynamic "parameter" {
    for_each = var.parameters
    content {
      name  = parameter.value.name
      value = parameter.value.value
    }
  }

  tags = var.tags
}

# =============================================================================
# Replication Group (Redis Cluster)
# =============================================================================

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = var.cluster_id
  description          = "Redis cluster for ${var.cluster_id}"

  # Engine
  engine               = "redis"
  engine_version       = var.engine_version
  node_type            = var.node_type
  parameter_group_name = aws_elasticache_parameter_group.main.name
  port                 = var.port

  # Cluster configuration
  num_cache_clusters         = var.num_cache_clusters
  automatic_failover_enabled = var.num_cache_clusters > 1
  multi_az_enabled           = var.num_cache_clusters > 1

  # Network
  subnet_group_name  = var.subnet_group_name
  security_group_ids = [aws_security_group.redis.id]

  # Security
  at_rest_encryption_enabled = var.at_rest_encryption_enabled
  transit_encryption_enabled = var.transit_encryption_enabled
  auth_token                 = local.auth_token

  # Maintenance
  maintenance_window         = var.maintenance_window
  snapshot_window            = var.snapshot_window
  snapshot_retention_limit   = var.snapshot_retention_limit
  auto_minor_version_upgrade = var.auto_minor_version_upgrade

  # Notifications
  notification_topic_arn = var.notification_topic_arn

  tags = merge(var.tags, {
    Name = var.cluster_id
  })

  # ARCH-018 fix: prevent accidental destruction of the Redis replication group
  lifecycle {
    prevent_destroy = true
    ignore_changes  = [auth_token]
  }
}

# =============================================================================
# Store Credentials in Secrets Manager
# SEC-008 fix: removed the 'url' field that embedded the auth_token in a Redis
# connection URL string. Applications must compose the connection URL at runtime
# from the separate host/port/auth_token fields to avoid credential exposure
# through application log output.
# SEC-010 fix: added aws_secretsmanager_secret_rotation resource.
# =============================================================================

resource "aws_secretsmanager_secret" "redis" {
  name_prefix = "${var.cluster_id}-redis-"
  description = "Redis credentials for ${var.cluster_id}"

  tags = var.tags
}

resource "aws_secretsmanager_secret_version" "redis" {
  secret_id = aws_secretsmanager_secret.redis.id
  secret_string = jsonencode({
    host       = aws_elasticache_replication_group.main.primary_endpoint_address
    port       = var.port
    auth_token = local.auth_token
  })
}

# SEC-010 fix: automatic rotation for the Redis auth token secret.
# Note: ElastiCache auth token rotation requires a custom Lambda — set
# enable_secret_rotation = true and provide rotation_lambda_arn when available.
resource "aws_secretsmanager_secret_rotation" "redis" {
  count               = var.enable_secret_rotation ? 1 : 0
  secret_id           = aws_secretsmanager_secret.redis.id
  rotation_lambda_arn = var.rotation_lambda_arn

  rotation_rules {
    automatically_after_days = 30
  }
}

# =============================================================================
# CloudWatch Alarms
# =============================================================================

resource "aws_cloudwatch_metric_alarm" "cpu" {
  count               = var.create_cloudwatch_alarms ? 1 : 0
  alarm_name          = "${var.cluster_id}-cpu-utilization"
  alarm_description   = "Redis CPU utilization"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ElastiCache"
  period              = 300
  statistic           = "Average"
  threshold           = 75

  dimensions = {
    CacheClusterId = aws_elasticache_replication_group.main.id
  }

  alarm_actions = var.alarm_actions
  ok_actions    = var.alarm_actions

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "memory" {
  count               = var.create_cloudwatch_alarms ? 1 : 0
  alarm_name          = "${var.cluster_id}-memory-usage"
  alarm_description   = "Redis memory usage"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "DatabaseMemoryUsagePercentage"
  namespace           = "AWS/ElastiCache"
  period              = 300
  statistic           = "Average"
  threshold           = 80

  dimensions = {
    CacheClusterId = aws_elasticache_replication_group.main.id
  }

  alarm_actions = var.alarm_actions
  ok_actions    = var.alarm_actions

  tags = var.tags
}
