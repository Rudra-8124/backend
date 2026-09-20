variable "environment" {
  description = "Deployment environment name"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID where security groups will be created"
  type        = string
}

variable "api_container_port" {
  description = "Port exposed by the API container"
  type        = number
  default     = 3000
}
