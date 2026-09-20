output "kms_key_arn" {
  description = "ARN of the KMS customer managed key"
  value       = aws_kms_key.main.arn
}

output "kms_key_id" {
  description = "ID of the KMS customer managed key"
  value       = aws_kms_key.main.key_id
}

output "alb_security_group_id" {
  description = "Security group ID for the ALB"
  value       = aws_security_group.alb.id
}

output "ecs_tasks_security_group_id" {
  description = "Security group ID for ECS tasks"
  value       = aws_security_group.ecs_tasks.id
}

output "rds_security_group_id" {
  description = "Security group ID for RDS Postgres"
  value       = aws_security_group.rds.id
}

output "elasticache_security_group_id" {
  description = "Security group ID for ElastiCache Redis"
  value       = aws_security_group.elasticache.id
}

output "ecs_execution_role_arn" {
  description = "ARN of the ECS task execution role"
  value       = aws_iam_role.ecs_execution.arn
}

output "ecs_task_role_arn" {
  description = "ARN of the ECS application task role"
  value       = aws_iam_role.ecs_task.arn
}
