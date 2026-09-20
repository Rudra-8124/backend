variable "environment" {
  description = "Deployment environment name"
  type        = string
}

variable "subnet_ids" {
  description = "Private application subnet IDs for ECS tasks"
  type        = list(string)
}

variable "security_group_ids" {
  description = "Security group IDs for ECS tasks"
  type        = list(string)
}

variable "target_group_arn" {
  description = "ARN of the ALB target group for API service"
  type        = string
}

variable "execution_role_arn" {
  description = "ARN of the ECS task execution role"
  type        = string
}

variable "task_role_arn" {
  description = "ARN of the ECS application task role"
  type        = string
}

variable "kms_key_arn" {
  description = "KMS key ARN for CloudWatch log group encryption"
  type        = string
}

variable "image_uri" {
  description = "Container image URI (ECR / GHCR)"
  type        = string
  default     = "ghcr.io/rudra-8124/backend:latest"
}

variable "api_cpu" {
  description = "CPU units for API task (1024 = 1 vCPU)"
  type        = number
  default     = 1024
}

variable "api_memory" {
  description = "Memory for API task in MiB"
  type        = number
  default     = 2048
}

variable "worker_cpu" {
  description = "CPU units for Worker task"
  type        = number
  default     = 512
}

variable "worker_memory" {
  description = "Memory for Worker task in MiB"
  type        = number
  default     = 1024
}

variable "db_secret_arn" {
  description = "Secrets Manager ARN for DB credentials"
  type        = string
}

variable "redis_secret_arn" {
  description = "Secrets Manager ARN for Redis credentials"
  type        = string
}

variable "database_url" {
  description = "Database connection URL (constructed without secrets)"
  type        = string
}

variable "redis_url" {
  description = "Redis connection URL (constructed without secrets)"
  type        = string
}
