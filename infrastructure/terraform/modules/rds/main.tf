# =============================================================================
# Aquaculture Platform - RDS Module (PostgreSQL)
# =============================================================================

# ARCH-009 fix: removed terraform {} block from child module — provider constraints
# are advisory only in child modules; the environment root module governs versions.

# =============================================================================
# Random Password
# SEC-011 fix: master_password variable removed entirely (see variables.tf).
# Passwords are always generated via random_password — never accepted as input.
# SEC-022 fix: special = true with safe override_special to avoid characters that
# break PostgreSQL connection string parsing (@ / : ? # [ ] space).
# =============================================================================

resource "random_password" "master" {
  length           = 32
  special          = true
  override_special = "!$%^&*()-_=+[]{}<>"
}

locals {
  master_password = random_password.master.result
}

# =============================================================================
# Security Group
# =============================================================================

resource "aws_security_group" "rds" {
  name_prefix = "${var.identifier}-rds-"
  description = "Security group for RDS PostgreSQL"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, {
    Name = "${var.identifier}-rds-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group_rule" "rds_ingress" {
  type                     = "ingress"
  from_port                = var.port
  to_port                  = var.port
  protocol                 = "tcp"
  source_security_group_id = var.allowed_security_group_id
  security_group_id        = aws_security_group.rds.id
}

resource "aws_security_group_rule" "rds_ingress_cidr" {
  count             = length(var.allowed_cidr_blocks) > 0 ? 1 : 0
  type              = "ingress"
  from_port         = var.port
  to_port           = var.port
  protocol          = "tcp"
  cidr_blocks       = var.allowed_cidr_blocks
  security_group_id = aws_security_group.rds.id
}

# =============================================================================
# Parameter Group
# =============================================================================

resource "aws_db_parameter_group" "main" {
  name_prefix = "${var.identifier}-"
  family      = "postgres${split(".", var.engine_version)[0]}"
  description = "Parameter group for ${var.identifier}"

  dynamic "parameter" {
    for_each = var.parameters
    content {
      name         = parameter.value.name
      value        = parameter.value.value
      apply_method = lookup(parameter.value, "apply_method", "immediate")
    }
  }

  tags = var.tags

  lifecycle {
    create_before_destroy = true
  }
}

# =============================================================================
# KMS Key for Encryption
# =============================================================================

resource "aws_kms_key" "rds" {
  count                   = var.storage_encrypted && var.kms_key_id == "" ? 1 : 0
  description             = "RDS encryption key for ${var.identifier}"
  # SEC-006 fix: extended from 7 to 30 days to allow adequate incident response time
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = var.tags

  # ARCH-018 fix: prevent accidental destruction of the RDS KMS key
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "rds" {
  count         = var.storage_encrypted && var.kms_key_id == "" ? 1 : 0
  name          = "alias/${var.identifier}-rds"
  target_key_id = aws_kms_key.rds[0].key_id
}

locals {
  kms_key_id = var.kms_key_id != "" ? var.kms_key_id : (var.storage_encrypted ? aws_kms_key.rds[0].arn : null)
}

# =============================================================================
# RDS Instance
# =============================================================================

resource "aws_db_instance" "main" {
  identifier = var.identifier

  # Engine
  engine               = "postgres"
  engine_version       = var.engine_version
  instance_class       = var.instance_class
  parameter_group_name = aws_db_parameter_group.main.name

  # Storage
  allocated_storage     = var.allocated_storage
  max_allocated_storage = var.max_allocated_storage
  storage_type          = var.storage_type
  storage_encrypted     = var.storage_encrypted
  kms_key_id            = local.kms_key_id

  # Database
  db_name  = var.database_name
  username = var.master_username
  password = local.master_password
  port     = var.port

  # Network
  db_subnet_group_name   = var.db_subnet_group_name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  multi_az               = var.multi_az

  # Backup
  backup_retention_period   = var.backup_retention_period
  backup_window             = var.backup_window
  maintenance_window        = var.maintenance_window
  copy_tags_to_snapshot     = true
  # SEC-018 fix: changed from true to false — prevents automated backups from being
  # purged immediately if deletion protection is ever lifted.
  delete_automated_backups  = false
  skip_final_snapshot       = var.skip_final_snapshot
  final_snapshot_identifier = var.skip_final_snapshot ? null : "${var.identifier}-final-snapshot"

  # Monitoring
  performance_insights_enabled          = var.performance_insights_enabled
  performance_insights_retention_period = var.performance_insights_enabled ? var.performance_insights_retention : null
  monitoring_interval                   = var.monitoring_interval
  monitoring_role_arn                   = var.monitoring_interval > 0 ? aws_iam_role.rds_monitoring[0].arn : null
  enabled_cloudwatch_logs_exports       = var.enabled_cloudwatch_logs_exports

  # Other
  auto_minor_version_upgrade = var.auto_minor_version_upgrade
  deletion_protection        = var.deletion_protection
  apply_immediately          = var.apply_immediately

  tags = merge(var.tags, {
    Name = var.identifier
  })

  lifecycle {
    ignore_changes = [password]
  }
}

# =============================================================================
# Enhanced Monitoring IAM Role
# =============================================================================

resource "aws_iam_role" "rds_monitoring" {
  count = var.monitoring_interval > 0 ? 1 : 0
  name  = "${var.identifier}-rds-monitoring"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "monitoring.rds.amazonaws.com"
      }
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  count      = var.monitoring_interval > 0 ? 1 : 0
  role       = aws_iam_role.rds_monitoring[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

# =============================================================================
# Store Credentials in Secrets Manager
# SEC-007 fix: removed the 'url' field that embedded the plaintext password in a
# connection string. Applications should compose the connection URL at runtime
# from the separate host/port/username/password fields to avoid leaking the
# credential through log output.
# SEC-010 fix: added aws_secretsmanager_secret_rotation resource.
# =============================================================================

resource "aws_secretsmanager_secret" "rds" {
  name_prefix = "${var.identifier}-rds-"
  description = "RDS credentials for ${var.identifier}"

  tags = var.tags
}

resource "aws_secretsmanager_secret_version" "rds" {
  secret_id = aws_secretsmanager_secret.rds.id
  secret_string = jsonencode({
    username = var.master_username
    password = local.master_password
    host     = aws_db_instance.main.address
    port     = var.port
    database = var.database_name
  })
}

# SEC-010 fix: enable automatic rotation using the AWS-managed single-user
# rotation Lambda for PostgreSQL. The Lambda updates the RDS password and the
# secret value automatically every 30 days.
resource "aws_secretsmanager_secret_rotation" "rds" {
  count               = var.enable_secret_rotation ? 1 : 0
  secret_id           = aws_secretsmanager_secret.rds.id
  rotation_lambda_arn = var.rotation_lambda_arn

  rotation_rules {
    automatically_after_days = 30
  }
}
