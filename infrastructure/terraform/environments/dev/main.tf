# =============================================================================
# Aquaculture Platform - Development Environment
# =============================================================================

terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket         = "aquaculture-terraform-state"
    key            = "dev/terraform.tfstate"
    region         = "eu-west-1"
    encrypt        = true
    dynamodb_table = "aquaculture-terraform-locks"
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.common_tags
  }
}

locals {
  project_name = "aquaculture"
  environment  = "dev"
  cluster_name = "${local.project_name}-${local.environment}"

  common_tags = {
    Project     = local.project_name
    Environment = local.environment
    ManagedBy   = "terraform"
  }

  availability_zones = ["${var.aws_region}a", "${var.aws_region}b"]
}

# =============================================================================
# Networking (Cost-optimized for dev)
# =============================================================================

module "networking" {
  source = "../../modules/networking"

  project_name       = local.project_name
  environment        = local.environment
  vpc_cidr           = "10.1.0.0/16"
  availability_zones = local.availability_zones
  cluster_name       = local.cluster_name

  enable_nat_gateway = true
  single_nat_gateway = true  # Cost saving
  enable_flow_logs   = false # Cost saving

  tags = local.common_tags
}

# =============================================================================
# EKS Cluster (Minimal for dev)
# =============================================================================

module "eks" {
  source = "../../modules/eks"

  cluster_name       = local.cluster_name
  kubernetes_version = "1.29"

  vpc_id     = module.networking.vpc_id
  subnet_ids = module.networking.private_subnet_ids

  endpoint_public_access = true

  node_groups = {
    general = {
      instance_types = ["t3.medium"]
      capacity_type  = "SPOT"  # Cost saving
      disk_size      = 50
      desired_size   = 2
      min_size       = 1
      max_size       = 4
      labels         = {}
      taints         = []
    }
  }

  enable_ebs_csi_driver = true
  log_retention_days    = 7  # Shorter retention

  tags = local.common_tags
}

# =============================================================================
# RDS (Minimal for dev)
# =============================================================================

module "rds" {
  source = "../../modules/rds"

  identifier           = "${local.project_name}-${local.environment}"
  vpc_id               = module.networking.vpc_id
  db_subnet_group_name = module.networking.db_subnet_group_name

  allowed_security_group_id = module.eks.cluster_security_group_id

  engine_version = "16.1"
  instance_class = "db.t3.medium"

  allocated_storage     = 20
  max_allocated_storage = 50
  storage_encrypted     = true

  multi_az                = false  # Cost saving
  backup_retention_period = 1
  deletion_protection     = false  # Easy cleanup
  skip_final_snapshot     = true

  performance_insights_enabled = false  # Cost saving
  monitoring_interval          = 0      # Disable enhanced monitoring

  tags = local.common_tags
}

# =============================================================================
# ElastiCache (Minimal for dev)
# =============================================================================

module "elasticache" {
  source = "../../modules/elasticache"

  cluster_id        = "${local.project_name}-${local.environment}"
  vpc_id            = module.networking.vpc_id
  subnet_group_name = module.networking.elasticache_subnet_group_name

  allowed_security_group_id = module.eks.cluster_security_group_id

  engine_version     = "7.1"
  node_type          = "cache.t3.small"
  num_cache_clusters = 1  # No replication for dev

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true

  snapshot_retention_limit = 1
  create_cloudwatch_alarms = false

  tags = local.common_tags
}

# =============================================================================
# Outputs
# =============================================================================

output "vpc_id" {
  value = module.networking.vpc_id
}

output "eks_cluster_name" {
  value = module.eks.cluster_name
}

output "eks_cluster_endpoint" {
  value = module.eks.cluster_endpoint
}

output "rds_endpoint" {
  value     = module.rds.endpoint
  sensitive = true
}

output "redis_endpoint" {
  value     = module.elasticache.primary_endpoint
  sensitive = true
}
