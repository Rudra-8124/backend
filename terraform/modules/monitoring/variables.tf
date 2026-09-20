variable "environment" {
  description = "Deployment environment name"
  type        = string
}

variable "ecs_cluster_name" {
  description = "Name of the ECS cluster"
  type        = string
}

variable "ecs_api_service_name" {
  description = "Name of the API ECS service"
  type        = string
}

variable "rds_instance_id" {
  description = "Identifier of the RDS instance"
  type        = string
}

variable "elasticache_cluster_id" {
  description = "Identifier of the ElastiCache replication group"
  type        = string
}

variable "alb_arn_suffix" {
  description = "ARN suffix of the Application Load Balancer"
  type        = string
}

variable "target_group_arn_suffix" {
  description = "ARN suffix of the API target group"
  type        = string
}
