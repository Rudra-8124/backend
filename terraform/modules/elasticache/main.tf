# Generate secure auth token for Redis transit encryption
resource "random_password" "redis_auth" {
  length  = 32
  special = false
}

# Store Redis auth token in Secrets Manager
resource "aws_secretsmanager_secret" "redis_auth" {
  name                    = "amrutam/${var.environment}/redis-auth"
  description             = "Redis AUTH token for Amrutam ${var.environment}"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = 0

  tags = {
    Name = "amrutam-${var.environment}-redis-secret"
  }
}

resource "aws_secretsmanager_secret_version" "redis_auth" {
  secret_id     = aws_secretsmanager_secret.redis_auth.id
  secret_string = random_password.redis_auth.result
}

# Subnet group in private data subnets
resource "aws_elasticache_subnet_group" "redis" {
  name        = "amrutam-${var.environment}-redis-subnet-group"
  description = "Subnet group for Amrutam Redis Multi-AZ"
  subnet_ids  = var.subnet_ids

  tags = {
    Name = "amrutam-${var.environment}-redis-subnet-group"
  }
}

# Redis parameter group
resource "aws_elasticache_parameter_group" "redis7" {
  name        = "amrutam-${var.environment}-redis7-params"
  family      = "redis7"
  description = "Custom parameter group for Redis 7"

  parameter {
    name  = "maxmemory-policy"
    value = "volatile-lru"
  }

  parameter {
    name  = "notify-keyspace-events"
    value = "Ex"
  }

  tags = {
    Name = "amrutam-${var.environment}-redis7-params"
  }
}

# Redis Replication Group (Multi-AZ with automatic failover)
resource "aws_elasticache_replication_group" "redis" {
  replication_group_id = "amrutam-${var.environment}-redis"
  description          = "Redis 7 Cluster for Amrutam Telemedicine"
  node_type            = var.node_type
  num_cache_clusters   = var.num_cache_clusters
  port                 = 6379
  parameter_group_name = aws_elasticache_parameter_group.redis7.name
  subnet_group_name    = aws_elasticache_subnet_group.redis.name
  security_group_ids   = var.security_group_ids

  # Multi-AZ & Automatic Failover
  automatic_failover_enabled = true
  multi_az_enabled           = true

  # Encryption: In-transit (TLS) and At-rest (KMS CMK)
  transit_encryption_enabled = true
  transit_encryption_mode    = "required"
  auth_token                 = random_password.redis_auth.result
  at_rest_encryption_enabled = true
  kms_key_id                 = var.kms_key_arn

  auto_minor_version_upgrade = true
  maintenance_window         = "sun:03:00-sun:04:00"
  snapshot_retention_limit   = 7
  snapshot_window            = "02:00-03:00"

  tags = {
    Name = "amrutam-${var.environment}-redis"
  }

  lifecycle {
    ignore_changes = [auth_token]
  }
}
