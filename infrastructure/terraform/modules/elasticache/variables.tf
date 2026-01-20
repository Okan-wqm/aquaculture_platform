# =============================================================================
# Aquaculture Platform - ElastiCache Module Variables
# =============================================================================

variable "cluster_id" {
  description = "ElastiCache cluster ID"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID"
  type        = string
}

variable "subnet_group_name" {
  description = "ElastiCache subnet group name"
  type        = string
}

variable "allowed_security_group_id" {
  description = "Security group ID allowed to connect"
  type        = string
}

variable "engine_version" {
  description = "Redis engine version"
  type        = string
  default     = "7.1"
}

variable "node_type" {
  description = "ElastiCache node type"
  type        = string
  default     = "cache.t3.medium"
}

variable "num_cache_clusters" {
  description = "Number of cache clusters (nodes)"
  type        = number
  default     = 2
}

variable "port" {
  description = "Redis port"
  type        = number
  default     = 6379
}

variable "at_rest_encryption_enabled" {
  description = "Enable encryption at rest"
  type        = bool
  default     = true
}

variable "transit_encryption_enabled" {
  description = "Enable encryption in transit"
  type        = bool
  default     = true
}

variable "auth_token" {
  description = "Auth token for Redis (generated if empty)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "maintenance_window" {
  description = "Maintenance window"
  type        = string
  default     = "mon:05:00-mon:06:00"
}

variable "snapshot_window" {
  description = "Snapshot window"
  type        = string
  default     = "03:00-04:00"
}

variable "snapshot_retention_limit" {
  description = "Snapshot retention limit (days)"
  type        = number
  default     = 7
}

variable "auto_minor_version_upgrade" {
  description = "Enable auto minor version upgrade"
  type        = bool
  default     = true
}

variable "notification_topic_arn" {
  description = "SNS topic ARN for notifications"
  type        = string
  default     = null
}

variable "parameters" {
  description = "Redis parameters"
  type = list(object({
    name  = string
    value = string
  }))
  default = []
}

variable "create_cloudwatch_alarms" {
  description = "Create CloudWatch alarms"
  type        = bool
  default     = true
}

variable "alarm_actions" {
  description = "CloudWatch alarm actions"
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Tags"
  type        = map(string)
  default     = {}
}
