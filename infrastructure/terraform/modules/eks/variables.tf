# =============================================================================
# Aquaculture Platform - EKS Module Variables
# =============================================================================

variable "cluster_name" {
  description = "Name of the EKS cluster"
  type        = string
}

variable "kubernetes_version" {
  description = "Kubernetes version"
  type        = string
  default     = "1.29"
}

variable "vpc_id" {
  description = "VPC ID"
  type        = string
}

variable "subnet_ids" {
  description = "Subnet IDs for the EKS cluster"
  type        = list(string)
}

variable "endpoint_public_access" {
  description = "Enable public access to EKS API"
  type        = bool
  default     = true
}

# SEC-002 fix: default changed from ["0.0.0.0/0"] to [] — AWS treats an empty list
# as deny-all when endpoint_public_access is true. Callers must explicitly pass
# their permitted CIDR allowlist.
variable "public_access_cidrs" {
  description = "CIDR blocks that can access EKS API publicly. Must not be empty when endpoint_public_access is true."
  type        = list(string)
  default     = []
}

variable "cluster_log_types" {
  description = "EKS cluster log types to enable"
  type        = list(string)
  default     = ["api", "audit", "authenticator", "controllerManager", "scheduler"]
}

variable "log_retention_days" {
  description = "CloudWatch log retention in days"
  type        = number
  default     = 30
}

variable "node_groups" {
  description = "EKS node groups configuration"
  type = map(object({
    instance_types = list(string)
    capacity_type  = string
    disk_size      = number
    desired_size   = number
    min_size       = number
    max_size       = number
    labels         = map(string)
    taints = list(object({
      key    = string
      value  = string
      effect = string
    }))
  }))
  default = {
    general = {
      instance_types = ["t3.medium"]
      capacity_type  = "ON_DEMAND"
      disk_size      = 50
      desired_size   = 2
      min_size       = 1
      max_size       = 5
      labels         = {}
      taints         = []
    }
  }
}

variable "enable_ebs_csi_driver" {
  description = "Enable EBS CSI driver addon"
  type        = bool
  default     = true
}

# ARCH-012 fix: addon versions are now explicitly pinned. Update these values
# deliberately when upgrading addons. Use 'aws eks describe-addon-versions' to
# find available versions for your kubernetes_version.
variable "addon_versions" {
  description = "Pinned versions for EKS managed addons"
  type = object({
    vpc_cni        = string
    coredns        = string
    kube_proxy     = string
    ebs_csi_driver = string
  })
  default = {
    vpc_cni        = "v1.18.3-eksbuild.2"
    coredns        = "v1.11.3-eksbuild.1"
    kube_proxy     = "v1.29.7-eksbuild.5"
    ebs_csi_driver = "v1.37.0-eksbuild.1"
  }
}

variable "vpc_cidr" {
  description = "VPC CIDR block — used to scope EKS cluster security group egress to the VPC instead of 0.0.0.0/0 (SEC-012)"
  type        = string
  default     = "10.0.0.0/16"
}

# SEC-019 fix: KMS key ARN used to encrypt the root EBS volume on each node group
# via a launch template. When left empty, the module falls back to the EKS KMS key
# created for secrets encryption. Set to a dedicated key ARN for stricter separation.
variable "ebs_kms_key_arn" {
  description = "KMS key ARN for encrypting EKS node root EBS volumes. Defaults to the EKS secrets KMS key when empty."
  type        = string
  default     = ""
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}
