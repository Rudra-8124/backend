output "endpoint" {
  description = "Connection endpoint for the RDS instance"
  value       = aws_db_instance.postgres.endpoint
}

output "address" {
  description = "Hostname of the RDS instance"
  value       = aws_db_instance.postgres.address
}

output "port" {
  description = "Port of the RDS instance"
  value       = aws_db_instance.postgres.port
}

output "database_name" {
  description = "Name of the database"
  value       = aws_db_instance.postgres.db_name
}

output "secret_arn" {
  description = "ARN of the Secrets Manager secret storing database credentials"
  value       = aws_secretsmanager_secret.db_credentials.arn
}

output "resource_id" {
  description = "Resource ID of the RDS instance"
  value       = aws_db_instance.postgres.resource_id
}
