# =============================================================================
# Aquaculture Platform - Bootstrap: Terraform State Bucket
#
# ARCH-019 / SEC-021 fix: This configuration provisions and manages the S3 state
# bucket and DynamoDB lock table used by all other Terraform environments. It must
# be applied ONCE manually before any other environment can be initialised.
#
# Apply with:
#   cd infrastructure/terraform/bootstrap
#   terraform init
#   terraform apply
#
# State for this bootstrap module is stored locally (or in a separate bucket if
# you implement a two-layer bootstrap). Do NOT store it in the bucket it creates.
# =============================================================================

terraform {
  required_version = ">= 1.5, < 2.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# =============================================================================
# Variables
# =============================================================================

variable "aws_region" {
  description = "AWS region for the state bucket"
  type        = string
  default     = "eu-west-1"
}

variable "state_bucket_name" {
  description = "Name of the S3 bucket to store Terraform state"
  type        = string
  default     = "aquaculture-terraform-state"
}

variable "dynamodb_table_name" {
  description = "Name of the DynamoDB table for Terraform state locking"
  type        = string
  default     = "aquaculture-terraform-locks"
}

variable "terraform_role_arn" {
  description = "IAM role ARN that is allowed to read/write the state bucket"
  type        = string
}

# =============================================================================
# S3 State Bucket
# ARCH-019 fix: versioning enabled so corrupted state files can be recovered
# from S3 version history. Lifecycle rule retains 90 days of version history.
# =============================================================================

resource "aws_s3_bucket" "terraform_state" {
  bucket = var.state_bucket_name

  # prevent_destroy guards against accidental deletion of the state bucket
  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name      = var.state_bucket_name
    ManagedBy = "terraform-bootstrap"
    Purpose   = "terraform-state"
  }
}

resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

# SEC-021 fix: restrictive bucket policy — only the Terraform execution IAM role
# and the AWS account root can access state objects.
resource "aws_s3_bucket_policy" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DenyNonTerraformRoleAccess"
        Effect = "Deny"
        Principal = {
          AWS = "*"
        }
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject"
        ]
        Resource = "${aws_s3_bucket.terraform_state.arn}/*"
        Condition = {
          StringNotLike = {
            "aws:PrincipalArn" = [
              var.terraform_role_arn,
              "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
            ]
          }
        }
      },
      {
        Sid    = "DenyUnencryptedObjectUploads"
        Effect = "Deny"
        Principal = {
          AWS = "*"
        }
        Action   = "s3:PutObject"
        Resource = "${aws_s3_bucket.terraform_state.arn}/*"
        Condition = {
          StringNotEquals = {
            "s3:x-amz-server-side-encryption" = "aws:kms"
          }
        }
      }
    ]
  })
}

data "aws_caller_identity" "current" {}

# =============================================================================
# DynamoDB Lock Table
# =============================================================================

resource "aws_dynamodb_table" "terraform_locks" {
  name         = var.dynamodb_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name      = var.dynamodb_table_name
    ManagedBy = "terraform-bootstrap"
    Purpose   = "terraform-state-locking"
  }
}

# =============================================================================
# Outputs
# =============================================================================

output "state_bucket_name" {
  description = "Name of the Terraform state S3 bucket"
  value       = aws_s3_bucket.terraform_state.bucket
}

output "dynamodb_table_name" {
  description = "Name of the Terraform state lock DynamoDB table"
  value       = aws_dynamodb_table.terraform_locks.name
}
