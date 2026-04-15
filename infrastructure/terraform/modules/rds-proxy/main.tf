# =============================================================================
# Aquaculture Platform - RDS Proxy Module
# =============================================================================
#
# Deploys an AWS RDS Proxy in front of the target DB instance.
#
# Why RDS Proxy and not PgBouncer:
#   - Auto session-pinning preserves the platform's session-state
#     dependencies (TenantConnectionBootstrap SET search_path,
#     RlsConnectionBootstrap set_config(..., is_local=false), advisory
#     locks for billing/feeding cron, LISTEN/NOTIFY for outbox-notify
#     listeners, server-side prepared statements). PgBouncer in
#     transaction mode would silently break ALL of these.
#   - IAM auth + KMS key support baked in.
#   - Fail-over aware: when the underlying RDS instance fails over, the
#     proxy hides the topology change from clients (no reconnect storm).
#
# Cost: db.t3.medium-class proxy vCPU pricing ≈ $0.015 / vCPU-hour =
# ~$22/month per proxy in production. Lower for staging.

# -----------------------------------------------------------------------------
# Security group: proxy listens on 5432 from the workload SG, egresses to
# the DB SG on 5432.
# -----------------------------------------------------------------------------

resource "aws_security_group" "proxy" {
  name_prefix = "${var.identifier}-rds-proxy-"
  description = "Security group for RDS Proxy ${var.identifier}"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, {
    Name = "${var.identifier}-rds-proxy-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group_rule" "proxy_ingress_from_workloads" {
  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = var.allowed_security_group_id
  security_group_id        = aws_security_group.proxy.id
  description              = "Workloads (EKS / EC2) → RDS Proxy"
}

resource "aws_security_group_rule" "proxy_egress_to_db" {
  type                     = "egress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = var.db_security_group_id
  security_group_id        = aws_security_group.proxy.id
  description              = "RDS Proxy → DB instance"
}

# Reciprocal ingress on the DB SG so the proxy ENIs can connect.
# Idempotent — if the rule already exists from another module the apply
# fails loudly (intentional; surfaces accidental SG sharing).
resource "aws_security_group_rule" "db_ingress_from_proxy" {
  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.proxy.id
  security_group_id        = var.db_security_group_id
  description              = "RDS Proxy ${var.identifier} → DB instance"
}

# -----------------------------------------------------------------------------
# IAM: proxy assumes this role to read the master credentials secret.
# Scoped to the EXACT secret ARN — no wildcards, no cross-secret access.
# -----------------------------------------------------------------------------

data "aws_iam_policy_document" "proxy_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "proxy" {
  name_prefix        = "${var.identifier}-rds-proxy-"
  assume_role_policy = data.aws_iam_policy_document.proxy_assume_role.json
  tags               = var.tags
}

data "aws_iam_policy_document" "proxy_secrets_read" {
  statement {
    sid     = "ReadDbCredentialsSecret"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources = [var.db_secret_arn]
  }
  statement {
    sid     = "DecryptDbCredentialsSecret"
    actions = ["kms:Decrypt"]
    # Restricting to the AWS-managed Secrets Manager KMS key would be
    # tighter; today's RDS module uses a customer-managed KMS key for the
    # secret. Operators can pass the specific KMS key ARN here in a
    # future iteration.
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${data.aws_region.current.name}.amazonaws.com"]
    }
  }
}

data "aws_region" "current" {}

resource "aws_iam_role_policy" "proxy_secrets_read" {
  name   = "secrets-read"
  role   = aws_iam_role.proxy.id
  policy = data.aws_iam_policy_document.proxy_secrets_read.json
}

# -----------------------------------------------------------------------------
# CloudWatch log group for the proxy. Created up-front so retention is
# explicit (AWS default for auto-created log groups is "Never expire").
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "proxy" {
  name              = "/aws/rds/proxy/${var.identifier}"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

# -----------------------------------------------------------------------------
# RDS Proxy + target group + target.
# -----------------------------------------------------------------------------

resource "aws_db_proxy" "this" {
  name                   = var.identifier
  engine_family          = var.engine_family
  vpc_subnet_ids         = var.subnet_ids
  vpc_security_group_ids = [aws_security_group.proxy.id]
  role_arn               = aws_iam_role.proxy.arn

  require_tls            = var.require_tls
  idle_client_timeout    = var.idle_client_timeout_seconds
  debug_logging          = false  # Sensitive — leave off in prod, flip via console for an incident

  auth {
    auth_scheme = "SECRETS"
    iam_auth    = "DISABLED"  # Operators may flip to REQUIRED once the workloads carry IRSA-bound IAM auth.
    secret_arn  = var.db_secret_arn
  }

  tags = var.tags

  depends_on = [
    aws_iam_role_policy.proxy_secrets_read,
    aws_cloudwatch_log_group.proxy,
  ]
}

resource "aws_db_proxy_default_target_group" "this" {
  db_proxy_name = aws_db_proxy.this.name

  connection_pool_config {
    connection_borrow_timeout    = var.connection_borrow_timeout_seconds
    max_connections_percent      = var.max_connections_percent
    max_idle_connections_percent = var.max_idle_connections_percent
    session_pinning_filters      = var.session_pinning_filters
  }
}

resource "aws_db_proxy_target" "this" {
  db_proxy_name          = aws_db_proxy.this.name
  target_group_name      = aws_db_proxy_default_target_group.this.name
  db_instance_identifier = var.db_instance_identifier
}
