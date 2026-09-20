# Generate random master password for RDS
resource "random_password" "db_password" {
  length  = 32
  special = false
}

# Store RDS credentials in AWS Secrets Manager (KMS encrypted)
resource "aws_secretsmanager_secret" "db_credentials" {
  name                    = "amrutam/${var.environment}/rds-credentials"
  description             = "PostgreSQL master credentials for Amrutam ${var.environment}"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = 0

  tags = {
    Name = "amrutam-${var.environment}-rds-secret"
  }
}

resource "aws_secretsmanager_secret_version" "db_credentials" {
  secret_id = aws_secretsmanager_secret.db_credentials.id
  secret_string = jsonencode({
    engine   = "postgres"
    host     = aws_db_instance.postgres.address
    port     = aws_db_instance.postgres.port
    username = "amrutam_admin"
    password = random_password.db_password.result
    database = var.database_name
  })
}

# DB Subnet Group across private data subnets
resource "aws_db_subnet_group" "rds" {
  name        = "amrutam-${var.environment}-db-subnet-group"
  description = "Database subnet group for Amrutam RDS Multi-AZ"
  subnet_ids  = var.subnet_ids

  tags = {
    Name = "amrutam-${var.environment}-db-subnet-group"
  }
}

# DB Parameter Group (Postgres 16)
resource "aws_db_parameter_group" "postgres16" {
  name        = "amrutam-${var.environment}-pg16-params"
  family      = "postgres16"
  description = "Custom parameter group for PostgreSQL 16"

  parameter {
    name  = "shared_preload_libraries"
    value = "pg_stat_statements"
  }

  parameter {
    name  = "pg_stat_statements.track"
    value = "all"
  }

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  tags = {
    Name = "amrutam-${var.environment}-pg16-params"
  }
}

# RDS PostgreSQL 16 Multi-AZ Instance
resource "aws_db_instance" "postgres" {
  identifier                  = "amrutam-${var.environment}-postgres"
  engine                      = "postgres"
  engine_version              = "16.2"
  instance_class              = var.instance_class
  allocated_storage           = var.allocated_storage
  max_allocated_storage       = var.max_allocated_storage
  storage_type                = "gp3"
  db_name                     = var.database_name
  username                    = "amrutam_admin"
  password                    = random_password.db_password.result
  port                        = 5432
  multi_az                    = true
  publicly_accessible         = false
  db_subnet_group_name        = aws_db_subnet_group.rds.name
  vpc_security_group_ids      = var.security_group_ids
  parameter_group_name        = aws_db_parameter_group.postgres16.name
  auto_minor_version_upgrade  = true
  allow_major_version_upgrade = false

  # High Availability, Backup & Retention
  backup_retention_period   = 14
  backup_window             = "03:00-04:00"
  maintenance_window        = "sun:04:30-sun:05:30"
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "amrutam-${var.environment}-postgres-final-snapshot"

  # Encryption at rest via KMS CMK
  storage_encrypted = true
  kms_key_id        = var.kms_key_arn

  # Observability & Performance Insights
  performance_insights_enabled          = true
  performance_insights_kms_key_id       = var.kms_key_arn
  performance_insights_retention_period = 731 # 2 years
  enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade"]

  tags = {
    Name = "amrutam-${var.environment}-postgres"
  }

  lifecycle {
    ignore_changes = [password]
  }
}
