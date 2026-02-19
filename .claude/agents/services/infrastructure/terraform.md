---
name: terraform
description: Knowledge base for Terraform - AWS infrastructure modules (VPC, EKS, RDS, ElastiCache) and environment configurations
---

# Terraform Knowledge Base

## Overview

Terraform manages the AWS cloud infrastructure for the aquaculture platform. The design uses reusable modules (networking, EKS, RDS, ElastiCache) composed by environment-specific configurations. State is stored in S3 with DynamoDB locking. Target regions and environments: `dev` and `production`.

## Directory Structure

```
infrastructure/terraform/
  modules/
    networking/
      main.tf        # VPC, subnets, NAT, route tables, VPC flow logs
      variables.tf   # vpc_cidr, availability_zones, enable_nat_gateway, etc.
      outputs.tf     # vpc_id, public/private/database subnet IDs, subnet group names
    eks/
      main.tf        # EKS cluster, node groups, KMS, CloudWatch, IAM, OIDC, addons
      variables.tf   # cluster_name, kubernetes_version, node_groups, etc.
      outputs.tf     # cluster_endpoint, cluster_ca_certificate, cluster_name
    rds/
      main.tf        # RDS PostgreSQL, parameter groups, subnet group, security group
      variables.tf   # engine_version, instance_class, storage, backup, monitoring
      outputs.tf     # endpoint, secret_arn
    elasticache/
      main.tf        # Redis ElastiCache replication group, CloudWatch alarms
      variables.tf   # engine_version, node_type, num_cache_clusters, encryption
      outputs.tf     # primary_endpoint, secret_arn
  environments/
    production/
      main.tf        # Production: multi-AZ, HA NAT, large instances, 30d backup
      variables.tf   # aws_region, allowed_cidrs
    dev/
      main.tf        # Dev: single NAT, smaller instances, shorter retention
      variables.tf   # aws_region
```

## Key Files & Configurations

### Terraform Versions

- Terraform: `>= 1.0`
- AWS provider: `~> 5.0`
- Kubernetes provider: `~> 2.0`
- Helm provider: `~> 2.0`

### State Backend (Production)

```hcl
backend "s3" {
  bucket         = "aquaculture-terraform-state"
  key            = "production/terraform.tfstate"
  region         = "eu-west-1"
  encrypt        = true
  dynamodb_table = "aquaculture-terraform-locks"
}
```

State bucket in `eu-west-1`, encrypted, with DynamoDB locking to prevent concurrent applies.

### Networking Module

Creates a 3-tier VPC:

**Subnet tiers** (all spanning 3 AZs):
- **Public subnets**: `cidrsubnet(vpc_cidr, 4, 0-2)` - for load balancers, NAT gateways. Tagged with `kubernetes.io/role/elb=1`
- **Private subnets**: `cidrsubnet(vpc_cidr, 4, 3-5)` - for EKS nodes, ElastiCache. Tagged `kubernetes.io/role/internal-elb=1`
- **Database subnets**: `cidrsubnet(vpc_cidr, 4, 6-8)` - isolated, no internet routing

**NAT Gateway**: Per-AZ in production (`single_nat_gateway: false`), single in dev.

**VPC Flow Logs**: Enabled in production, logs to CloudWatch `/aws/vpc-flow-log/{project}-{env}`, 90-day retention.

**Outputs used by other modules**: `vpc_id`, `private_subnet_ids`, `db_subnet_group_name`, `elasticache_subnet_group_name`.

### EKS Module

```hcl
resource "aws_eks_cluster" "main" {
  name     = var.cluster_name
  version  = "1.29"  # In production

  vpc_config {
    subnet_ids              = var.subnet_ids  # private subnets
    endpoint_private_access = true
    endpoint_public_access  = true            # restricted by public_access_cidrs
    security_group_ids      = [aws_security_group.cluster.id]
  }

  encryption_config {
    provider { key_arn = aws_kms_key.eks.arn }
    resources = ["secrets"]  # KMS-encrypt all K8s secrets
  }
}
```

**Node Groups** (production):
- `general`: `t3.large`, ON_DEMAND, 3 desired / 2 min / 10 max, 100GB disk
- `spot`: `t3.large|t3.xlarge|m5.large`, SPOT, 2 desired / 0 min / 20 max, tainted `spot=true:NoSchedule`

**EKS Addons**: `vpc-cni`, `coredns`, `kube-proxy`, `aws-ebs-csi-driver` (with IRSA role)

**OIDC Provider**: Created for IRSA (IAM Roles for Service Accounts). Allows K8s service accounts to assume IAM roles.

**IAM Roles**:
- `{cluster}-cluster-role`: AmazonEKSClusterPolicy + AmazonEKSVPCResourceController
- `{cluster}-node-role`: AmazonEKSWorkerNodePolicy + AmazonEKS_CNI_Policy + AmazonEC2ContainerRegistryReadOnly
- `{cluster}-ebs-csi-driver`: AmazonEBSCSIDriverPolicy (IRSA)

### RDS Module

PostgreSQL 16 on `db.r6g.large` (production):
- Multi-AZ: `true`
- Storage: 100GB initial, 500GB max, `gp3` type, encrypted
- Backup: 30-day retention
- Deletion protection: enabled
- Performance Insights: enabled (7-day retention)
- Enhanced monitoring: 60-second interval
- Parameters: `log_statement=all`, `log_min_duration_statement=1000` (log slow queries >1s)
- Credentials managed by AWS Secrets Manager (output: `secret_arn`)

### ElastiCache Module

Redis 7.1 on `cache.r6g.large` (production):
- 3 cache clusters (1 primary + 2 replicas)
- At-rest encryption: enabled
- In-transit encryption: enabled (TLS)
- Snapshot retention: 7 days
- CloudWatch alarms: enabled
- Credentials in Secrets Manager (output: `secret_arn`)

### Production Environment Composition

```hcl
module "networking" {
  vpc_cidr           = "10.0.0.0/16"
  availability_zones = ["eu-west-1a", "eu-west-1b", "eu-west-1c"]
  enable_nat_gateway = true
  single_nat_gateway = false  # HA: one NAT per AZ
  enable_flow_logs   = true
}

module "eks" {
  kubernetes_version     = "1.29"
  subnet_ids             = module.networking.private_subnet_ids
  endpoint_public_access = true
  public_access_cidrs    = var.allowed_cidrs  # Restrict kubectl access
  enable_ebs_csi_driver  = true
  log_retention_days     = 90
}

module "rds" {
  engine_version          = "16.1"
  instance_class          = "db.r6g.large"
  multi_az                = true
  backup_retention_period = 30
  deletion_protection     = true
}

module "elasticache" {
  engine_version     = "7.1"
  node_type          = "cache.r6g.large"
  num_cache_clusters = 3
}
```

### Outputs

```hcl
output "vpc_id"              { value = module.networking.vpc_id }
output "eks_cluster_name"    { value = module.eks.cluster_name }
output "eks_cluster_endpoint"{ value = module.eks.cluster_endpoint }
output "rds_endpoint"        { value = module.rds.endpoint; sensitive = true }
output "redis_endpoint"      { value = module.elasticache.primary_endpoint; sensitive = true }
output "rds_secret_arn"      { value = module.rds.secret_arn }
output "redis_secret_arn"    { value = module.elasticache.secret_arn }
```

## Dependencies / Integrations

- **CI/CD**: `infra-terraform-plan.yml` and `infra-terraform-apply.yml` workflows automate plan and apply
- **Kubernetes**: Terraform provisions EKS, then K8s manifests/Helm deploy applications
- **Helm**: The production `main.tf` includes the Helm provider to deploy the chart post-EKS creation
- **AWS Secrets Manager**: RDS and Redis credentials stored as secrets, referenced by ARN in EKS pod configurations

## Known Gotchas

1. **`lifecycle { ignore_changes = [scaling_config[0].desired_size] }`** on node groups - Allows cluster autoscaler to manage desired size without Terraform drift.

2. **KMS key deletion window is 7 days** - If you delete and recreate EKS, you must wait 7 days for the old KMS key to be deleted before reusing the alias.

3. **`endpoint_public_access = true` with `public_access_cidrs`** - In production, the EKS API is publicly accessible but restricted to `var.allowed_cidrs`. This allows CI/CD to run kubectl without VPN.

4. **Single vs multiple NAT gateways** - Production uses one NAT per AZ (3 total) for HA. This costs ~$135/month. Dev uses single NAT to save cost.

5. **EBS CSI driver requires IRSA** - Without the IRSA role, PersistentVolumeClaims will fail to bind. The role uses the OIDC provider's thumbprint.

6. **RDS in `database` subnets** - The database subnets have no internet routing. RDS is only accessible from the EKS security group.

7. **State file region** - State is in `eu-west-1`. If deploying to a different region, initialize with the correct backend config override.

8. **Node group `desired_size` drift** - After applying, the cluster autoscaler changes `desired_size`. Terraform will show drift on subsequent plans but the `ignore_changes` lifecycle prevents it from reverting.
