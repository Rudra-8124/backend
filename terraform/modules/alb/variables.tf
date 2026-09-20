variable "environment" {
  description = "Deployment environment name"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID where ALB and target group are created"
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnet IDs where ALB is deployed"
  type        = list(string)
}

variable "security_group_ids" {
  description = "Security group IDs for ALB"
  type        = list(string)
}

variable "certificate_arn" {
  description = "ARN of ACM certificate for HTTPS listener"
  type        = string
  default     = ""
}

variable "container_port" {
  description = "Port the target container is listening on"
  type        = number
  default     = 3000
}
