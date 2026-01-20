# =============================================================================
# Aquaculture Platform - Production Variables
# =============================================================================

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "eu-west-1"
}

variable "allowed_cidrs" {
  description = "CIDR blocks allowed to access EKS API"
  type        = list(string)
  default     = ["0.0.0.0/0"]  # Restrict in production!
}
