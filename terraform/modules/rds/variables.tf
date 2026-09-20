variable "environment" {
  description = "Deployment environment name"
  type        = string
}

variable "subnet_ids" {
  description = "Subnet IDs for DB subnet group (private data subnets)"
  type        = list(string)
}

variable "security_group_ids" {
  description = "Security group IDs for RDS instance"
  type        = list(string)
}

variable "kms_key_arn" {
  description = "KMS key ARN for RDS storage encryption"
  type        = string
}

variable "instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.r6g.large"
}

variable "allocated_storage" {
  description = "Initial allocated storage in GB"
  type        = number
  default     = 100
}

variable "max_allocated_storage" {
  description = "Maximum storage limit in GB for autoscaling"
  type        = number
  default     = 1000
}

variable "database_name" {
  description = "Name of the default database to create"
  type        = string
  default     = "amrutam"
}
