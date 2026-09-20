output "alb_dns_name" {
  description = "Public DNS name of the Application Load Balancer"
  value       = module.alb.alb_dns_name
}

output "api_endpoint" {
  description = "Base URL of the public API"
  value       = "https://${module.alb.alb_dns_name}"
}

output "vpc_id" {
  description = "ID of the created VPC"
  value       = module.network.vpc_id
}

output "ecs_cluster_name" {
  description = "Name of the ECS cluster"
  value       = module.ecs.cluster_name
}

output "rds_endpoint" {
  description = "Primary endpoint for RDS Postgres"
  value       = module.rds.endpoint
}

output "elasticache_primary_endpoint" {
  description = "Primary write endpoint for Redis cluster"
  value       = module.elasticache.primary_endpoint_address
}

output "kms_key_arn" {
  description = "ARN of KMS CMK"
  value       = module.security.kms_key_arn
}
