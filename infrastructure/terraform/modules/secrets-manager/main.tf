# =============================================================================
# Aquaculture Platform - Secrets Manager Module
# =============================================================================
#
# Provisions AWS Secrets Manager secrets referenced by the Helm chart's
# ExternalSecret templates. Values are NOT stored by Terraform — operators
# populate plaintext out-of-band via AWS Console/CLI.
#
# Design constraints:
# - Every secret is encrypted with a customer-managed KMS key (kms_key_arn),
#   never the aws/secretsmanager default.
# - recovery_window_days defaults to 30 — undeleting a mis-deleted secret
#   during an incident is cheaper than rebuilding from rotation history.
# - Rotation is OPTIONAL per secret. Enable only when a rotation Lambda
#   is supplied (DB creds, typically). App-level secrets (JWT, Stripe,
#   pepper) rotate via the runbook cadence enforced by
#   .github/workflows/secret-rotation-reminder.yml — those are deliberately
#   NOT wired to aws_secretsmanager_secret_rotation.

locals {
  secrets_by_name = { for s in var.secrets : s.name => s }
}

resource "aws_secretsmanager_secret" "this" {
  for_each = local.secrets_by_name

  name                    = "${var.name_prefix}/${each.value.name}"
  description             = each.value.description
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.recovery_window_days

  tags = merge(var.tags, {
    Name     = "${var.name_prefix}/${each.value.name}"
    SecretId = each.value.name
  })
}

resource "aws_secretsmanager_secret_rotation" "this" {
  for_each = {
    for name, s in local.secrets_by_name :
    name => s if s.rotation != null
  }

  secret_id           = aws_secretsmanager_secret.this[each.key].id
  rotation_lambda_arn = each.value.rotation.lambda_arn

  rotation_rules {
    automatically_after_days = each.value.rotation.days
  }

  # Default is to rotate immediately on creation — we intentionally skip the
  # initial rotation so the secret's first value (populated by operators
  # out-of-band) isn't thrown away before it's ever used.
  rotate_immediately = false
}
