output "primary_endpoint_address" {
  description = "Address of the primary write endpoint"
  value       = aws_elasticache_replication_group.redis.primary_endpoint_address
}

output "reader_endpoint_address" {
  description = "Address of the reader replica endpoint"
  value       = aws_elasticache_replication_group.redis.reader_endpoint_address
}

output "port" {
  description = "Port of the Redis cluster"
  value       = aws_elasticache_replication_group.redis.port
}

output "auth_token_secret_arn" {
  description = "ARN of Secrets Manager secret containing the Redis AUTH token"
  value       = aws_secretsmanager_secret.redis_auth.arn
}
