variable "aws_region" {
  description = "AWS region for deployment"
  type        = string
  default     = "ap-south-1"
}

variable "environment" {
  description = "Deployment environment (production, staging, dev)"
  type        = string
  default     = "production"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "List of availability zones to span across"
  type        = list(string)
  default     = ["ap-south-1a", "ap-south-1b", "ap-south-1c"]
}

variable "image_uri" {
  description = "Container image URI in GHCR or ECR"
  type        = string
  default     = "ghcr.io/rudra-8124/backend:latest"
}

variable "certificate_arn" {
  description = "ARN of the validated ACM SSL/TLS certificate"
  type        = string
  default     = ""
}

variable "rds_instance_class" {
  description = "RDS instance size"
  type        = string
  default     = "db.r6g.large"
}

variable "elasticache_node_type" {
  description = "ElastiCache Redis node type"
  type        = string
  default     = "cache.m6g.large"
}
