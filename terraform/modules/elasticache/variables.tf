variable "environment" {
  description = "Deployment environment name"
  type        = string
}

variable "subnet_ids" {
  description = "Subnet IDs for ElastiCache subnet group"
  type        = list(string)
}

variable "security_group_ids" {
  description = "Security group IDs for ElastiCache"
  type        = list(string)
}

variable "kms_key_arn" {
  description = "KMS key ARN for at-rest encryption"
  type        = string
}

variable "node_type" {
  description = "Instance type for Redis nodes"
  type        = string
  default     = "cache.m6g.large"
}

variable "num_cache_clusters" {
  description = "Number of cache clusters (1 primary + replicas)"
  type        = number
  default     = 2
}
