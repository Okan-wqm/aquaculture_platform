# =============================================================================
# Aquaculture Platform - EKS Module
# =============================================================================

# ARCH-009 fix: removed terraform {} block from child module — provider constraints
# are advisory only in child modules; the environment root module governs versions.

# =============================================================================
# EKS Cluster
# =============================================================================

resource "aws_eks_cluster" "main" {
  name     = var.cluster_name
  role_arn = aws_iam_role.cluster.arn
  version  = var.kubernetes_version

  vpc_config {
    subnet_ids              = var.subnet_ids
    endpoint_private_access = true
    endpoint_public_access  = var.endpoint_public_access
    public_access_cidrs     = var.public_access_cidrs
    security_group_ids      = [aws_security_group.cluster.id]
  }

  encryption_config {
    provider {
      key_arn = aws_kms_key.eks.arn
    }
    resources = ["secrets"]
  }

  enabled_cluster_log_types = var.cluster_log_types

  tags = merge(var.tags, {
    Name = var.cluster_name
  })

  # ARCH-018 fix: prevent accidental destruction of the EKS cluster
  lifecycle {
    prevent_destroy = true
  }

  depends_on = [
    aws_iam_role_policy_attachment.cluster_AmazonEKSClusterPolicy,
    aws_iam_role_policy_attachment.cluster_AmazonEKSVPCResourceController,
    aws_cloudwatch_log_group.cluster,
  ]
}

# =============================================================================
# Node Group Launch Templates
# SEC-019 fix: each node group gets a launch template that explicitly enables
# EBS encryption on the root volume with a customer-managed KMS key. This ensures
# node disk encryption is enforced by Terraform rather than relying on the AWS
# account-level default encryption setting.
# =============================================================================

locals {
  # Resolve the KMS key to use for EBS encryption: prefer the caller-supplied ARN,
  # fall back to the EKS secrets key created in this module.
  ebs_kms_key_arn = var.ebs_kms_key_arn != "" ? var.ebs_kms_key_arn : aws_kms_key.eks.arn
}

resource "aws_launch_template" "node_group" {
  for_each = var.node_groups

  name_prefix = "${var.cluster_name}-${each.key}-"
  description = "Launch template for EKS node group ${each.key} — enforces EBS encryption"

  ebs_optimized = true

  # Encrypt the root EBS volume with a customer-managed KMS key.
  # The device name /dev/xvda is the standard root device for Amazon Linux 2 / AL2023
  # EKS-optimised AMIs. disk_size from the node group variable sets the volume size.
  block_device_mappings {
    device_name = "/dev/xvda"

    ebs {
      volume_size           = each.value.disk_size
      volume_type           = "gp3"
      encrypted             = true
      kms_key_id            = local.ebs_kms_key_arn
      delete_on_termination = true
    }
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"  # IMDSv2 required — prevents SSRF-based metadata access
    http_put_response_hop_limit = 1
  }

  tags = var.tags

  lifecycle {
    create_before_destroy = true
  }
}

# =============================================================================
# EKS Node Groups
# =============================================================================

resource "aws_eks_node_group" "main" {
  for_each = var.node_groups

  cluster_name    = aws_eks_cluster.main.name
  node_group_name = each.key
  node_role_arn   = aws_iam_role.node[each.key].arn
  subnet_ids      = var.subnet_ids

  instance_types = each.value.instance_types
  capacity_type  = each.value.capacity_type
  # disk_size is omitted here because it is managed by the launch template
  # block_device_mappings above (setting both would cause a Terraform error).

  # SEC-019 fix: attach the launch template so EBS encryption is always enforced
  launch_template {
    id      = aws_launch_template.node_group[each.key].id
    version = aws_launch_template.node_group[each.key].latest_version
  }

  scaling_config {
    desired_size = each.value.desired_size
    min_size     = each.value.min_size
    max_size     = each.value.max_size
  }

  update_config {
    max_unavailable_percentage = 33
  }

  labels = merge(each.value.labels, {
    "node-group" = each.key
  })

  dynamic "taint" {
    for_each = each.value.taints
    content {
      key    = taint.value.key
      value  = taint.value.value
      effect = taint.value.effect
    }
  }

  tags = merge(var.tags, {
    Name = "${var.cluster_name}-${each.key}"
  })

  depends_on = [
    aws_iam_role_policy_attachment.node_AmazonEKSWorkerNodePolicy,
    aws_iam_role_policy_attachment.node_AmazonEKS_CNI_Policy,
    aws_iam_role_policy_attachment.node_AmazonEC2ContainerRegistryReadOnly,
  ]

  lifecycle {
    ignore_changes = [scaling_config[0].desired_size]
  }
}

# =============================================================================
# KMS Key for Secrets Encryption
# =============================================================================

resource "aws_kms_key" "eks" {
  description = "EKS Secret Encryption Key for ${var.cluster_name}"
  # SEC-006 fix: extended from 7 to 30 days to allow adequate incident response time
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = var.tags

  # ARCH-018 fix: prevent accidental destruction of the KMS key
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "eks" {
  name          = "alias/${var.cluster_name}-eks"
  target_key_id = aws_kms_key.eks.key_id
}

# =============================================================================
# CloudWatch Log Group
# =============================================================================

resource "aws_cloudwatch_log_group" "cluster" {
  name              = "/aws/eks/${var.cluster_name}/cluster"
  retention_in_days = var.log_retention_days
  # SEC-016 fix: encrypt log group with the EKS KMS key (reuses existing key at no extra cost)
  kms_key_id        = aws_kms_key.eks.arn

  tags = var.tags
}

# =============================================================================
# Security Groups
# =============================================================================

resource "aws_security_group" "cluster" {
  name_prefix = "${var.cluster_name}-cluster-"
  description = "EKS cluster security group"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, {
    Name = "${var.cluster_name}-cluster-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}

# SEC-012 fix: scope control-plane egress to the VPC CIDR (node ↔ control-plane
# traffic) rather than 0.0.0.0/0. A second rule allows HTTPS to AWS service
# endpoints (ECR, S3, STS, CloudWatch) which EKS system components require.
# EKS-managed ingress rules are added automatically by the service; no explicit
# ingress rules are defined here — relying on EKS-managed rules is intentional
# and documented to avoid maintaining a brittle manual allowlist.
resource "aws_security_group_rule" "cluster_egress_vpc" {
  description       = "Allow all egress within VPC (node-to-control-plane traffic)"
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = [var.vpc_cidr]
  security_group_id = aws_security_group.cluster.id
}

resource "aws_security_group_rule" "cluster_egress_https_aws" {
  description       = "Allow HTTPS egress to AWS service endpoints (ECR, S3, STS, CloudWatch)"
  type              = "egress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.cluster.id
}

# =============================================================================
# IAM Roles
# =============================================================================

# Cluster Role
resource "aws_iam_role" "cluster" {
  name = "${var.cluster_name}-cluster-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "eks.amazonaws.com"
      }
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "cluster_AmazonEKSClusterPolicy" {
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
  role       = aws_iam_role.cluster.name
}

resource "aws_iam_role_policy_attachment" "cluster_AmazonEKSVPCResourceController" {
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSVPCResourceController"
  role       = aws_iam_role.cluster.name
}

# ARCH-006 fix: separate node IAM roles per node group — each node group gets its
# own role so trust boundaries can be scoped independently. The for_each mirrors
# the node_groups map.
resource "aws_iam_role" "node" {
  for_each = var.node_groups
  name     = "${var.cluster_name}-${each.key}-node-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "node_AmazonEKSWorkerNodePolicy" {
  for_each   = var.node_groups
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"
  role       = aws_iam_role.node[each.key].name
}

resource "aws_iam_role_policy_attachment" "node_AmazonEKS_CNI_Policy" {
  for_each   = var.node_groups
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
  role       = aws_iam_role.node[each.key].name
}

resource "aws_iam_role_policy_attachment" "node_AmazonEC2ContainerRegistryReadOnly" {
  for_each   = var.node_groups
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
  role       = aws_iam_role.node[each.key].name
}

# SEC-019 fix: grant each node role permission to use the EBS KMS key so that
# EC2 can encrypt/decrypt the node root volumes at instance launch time.
resource "aws_iam_role_policy" "node_ebs_kms" {
  for_each = var.node_groups
  name     = "${var.cluster_name}-${each.key}-ebs-kms"
  role     = aws_iam_role.node[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "AllowEBSKMSUsage"
      Effect = "Allow"
      Action = [
        "kms:Encrypt",
        "kms:Decrypt",
        "kms:ReEncrypt*",
        "kms:GenerateDataKey*",
        "kms:DescribeKey",
        "kms:CreateGrant"
      ]
      Resource = local.ebs_kms_key_arn
    }]
  })
}

# =============================================================================
# OIDC Provider for IRSA
# =============================================================================

data "tls_certificate" "cluster" {
  url = aws_eks_cluster.main.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "cluster" {
  client_id_list = ["sts.amazonaws.com"]
  # Use all certificates in the chain for resilience against CA rotation
  thumbprint_list = data.tls_certificate.cluster.certificates[*].sha1_fingerprint
  url             = aws_eks_cluster.main.identity[0].oidc[0].issuer

  tags = var.tags
}

# =============================================================================
# EKS Addons
# =============================================================================

# ARCH-012 fix: pin explicit addon_version values; use PRESERVE on update to avoid
# overwriting operator customisations applied after initial creation.
resource "aws_eks_addon" "vpc_cni" {
  cluster_name                = aws_eks_cluster.main.name
  addon_name                  = "vpc-cni"
  addon_version               = var.addon_versions.vpc_cni
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "PRESERVE"

  tags = var.tags
}

resource "aws_eks_addon" "coredns" {
  cluster_name                = aws_eks_cluster.main.name
  addon_name                  = "coredns"
  addon_version               = var.addon_versions.coredns
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "PRESERVE"

  tags = var.tags

  depends_on = [aws_eks_node_group.main]
}

resource "aws_eks_addon" "kube_proxy" {
  cluster_name                = aws_eks_cluster.main.name
  addon_name                  = "kube-proxy"
  addon_version               = var.addon_versions.kube_proxy
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "PRESERVE"

  tags = var.tags
}

resource "aws_eks_addon" "ebs_csi_driver" {
  count                       = var.enable_ebs_csi_driver ? 1 : 0
  cluster_name                = aws_eks_cluster.main.name
  addon_name                  = "aws-ebs-csi-driver"
  addon_version               = var.addon_versions.ebs_csi_driver
  service_account_role_arn    = aws_iam_role.ebs_csi[0].arn
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "PRESERVE"

  tags = var.tags
}

# EBS CSI Driver IAM Role (IRSA)
resource "aws_iam_role" "ebs_csi" {
  count = var.enable_ebs_csi_driver ? 1 : 0
  name  = "${var.cluster_name}-ebs-csi-driver"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRoleWithWebIdentity"
      Effect = "Allow"
      Principal = {
        Federated = aws_iam_openid_connect_provider.cluster.arn
      }
      Condition = {
        StringEquals = {
          "${replace(aws_iam_openid_connect_provider.cluster.url, "https://", "")}:sub" = "system:serviceaccount:kube-system:ebs-csi-controller-sa"
        }
      }
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "ebs_csi" {
  count      = var.enable_ebs_csi_driver ? 1 : 0
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"
  role       = aws_iam_role.ebs_csi[0].name
}
