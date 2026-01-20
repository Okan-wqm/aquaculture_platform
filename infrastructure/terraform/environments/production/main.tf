# =============================================================================
# Aquaculture Platform - Production Environment
# =============================================================================

terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.0"
    }
  }

  backend "s3" {
    bucket         = "aquaculture-terraform-state"
    key            = "production/terraform.tfstate"
    region         = "eu-west-1"
    encrypt        = true
    dynamodb_table = "aquaculture-terraform-locks"
  }
}

# =============================================================================
# Provider Configuration
# =============================================================================

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.common_tags
  }
}

provider "kubernetes" {
  host                   = module.eks.cluster_endpoint
  cluster_ca_certificate = base64decode(module.eks.cluster_ca_certificate)

  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name]
  }
}

provider "helm" {
  kubernetes {
    host                   = module.eks.cluster_endpoint
    cluster_ca_certificate = base64decode(module.eks.cluster_ca_certificate)

    exec {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name]
    }
  }
}

# =============================================================================
# Local Variables
# =============================================================================

locals {
  project_name = "aquaculture"
  environment  = "production"
  cluster_name = "${local.project_name}-${local.environment}"

  common_tags = {
    Project     = local.project_name
    Environment = local.environment
    ManagedBy   = "terraform"
  }

  availability_zones = ["${var.aws_region}a", "${var.aws_region}b", "${var.aws_region}c"]
}

# =============================================================================
# Networking
# =============================================================================

module "networking" {
  source = "../../modules/networking"

  project_name       = local.project_name
  environment        = local.environment
  vpc_cidr           = "10.0.0.0/16"
  availability_zones = local.availability_zones
  cluster_name       = local.cluster_name

  enable_nat_gateway = true
  single_nat_gateway = false  # High availability for production
  enable_flow_logs   = true

  tags = local.common_tags
}

# =============================================================================
# EKS Cluster
# =============================================================================

module "eks" {
  source = "../../modules/eks"

  cluster_name       = local.cluster_name
  kubernetes_version = "1.29"

  vpc_id     = module.networking.vpc_id
  subnet_ids = module.networking.private_subnet_ids

  endpoint_public_access = true
  public_access_cidrs    = var.allowed_cidrs

  node_groups = {
    general = {
      instance_types = ["t3.large"]
      capacity_type  = "ON_DEMAND"
      disk_size      = 100
      desired_size   = 3
      min_size       = 2
      max_size       = 10
      labels = {
        workload = "general"
      }
      taints = []
    }
    spot = {
      instance_types = ["t3.large", "t3.xlarge", "m5.large"]
      capacity_type  = "SPOT"
      disk_size      = 100
      desired_size   = 2
      min_size       = 0
      max_size       = 20
      labels = {
        workload = "spot"
      }
      taints = [{
        key    = "spot"
        value  = "true"
        effect = "NO_SCHEDULE"
      }]
    }
  }

  enable_ebs_csi_driver = true
  log_retention_days    = 90

  tags = local.common_tags
}

# =============================================================================
# RDS (PostgreSQL)
# =============================================================================

module "rds" {
  source = "../../modules/rds"

  identifier           = "${local.project_name}-${local.environment}"
  vpc_id               = module.networking.vpc_id
  db_subnet_group_name = module.networking.db_subnet_group_name

  allowed_security_group_id = module.eks.cluster_security_group_id

  engine_version = "16.1"
  instance_class = "db.r6g.large"

  allocated_storage     = 100
  max_allocated_storage = 500
  storage_type          = "gp3"
  storage_encrypted     = true

  database_name   = "aquaculture"
  master_username = "aquaculture"

  multi_az                = true
  backup_retention_period = 30
  deletion_protection     = true

  performance_insights_enabled   = true
  performance_insights_retention = 7
  monitoring_interval            = 60

  parameters = [
    {
      name  = "log_statement"
      value = "all"
    },
    {
      name  = "log_min_duration_statement"
      value = "1000"
    }
  ]

  tags = local.common_tags
}

# =============================================================================
# ElastiCache (Redis)
# =============================================================================

module "elasticache" {
  source = "../../modules/elasticache"

  cluster_id        = "${local.project_name}-${local.environment}"
  vpc_id            = module.networking.vpc_id
  subnet_group_name = module.networking.elasticache_subnet_group_name

  allowed_security_group_id = module.eks.cluster_security_group_id

  engine_version     = "7.1"
  node_type          = "cache.r6g.large"
  num_cache_clusters = 3

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true

  snapshot_retention_limit = 7
  create_cloudwatch_alarms = true

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

output "rds_secret_arn" {
  value = module.rds.secret_arn
}

output "redis_secret_arn" {
  value = module.elasticache.secret_arn
}
