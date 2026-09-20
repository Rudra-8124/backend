# Data source for current AWS caller identity
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# KMS Customer Managed Key with automated rotation enabled
resource "aws_kms_key" "main" {
  description             = "KMS Key for Amrutam ${var.environment} encryption (RDS, Secrets, Logs)"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  policy = jsonencode({
    Version = "2012-10-17"
    Id      = "amrutam-${var.environment}-kms-policy"
    Statement = [
      {
        Sid    = "Enable IAM User Permissions"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
      {
        Sid    = "Allow CloudWatch Logs Encryption"
        Effect = "Allow"
        Principal = {
          Service = "logs.${data.aws_region.current.name}.amazonaws.com"
        }
        Action = [
          "kms:Encrypt*",
          "kms:Decrypt*",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:Describe*"
        ]
        Resource = "*"
      }
    ]
  })

  tags = {
    Name = "amrutam-${var.environment}-cmk"
  }
}

resource "aws_kms_alias" "main" {
  name          = "alias/amrutam-${var.environment}-key"
  target_key_id = aws_kms_key.main.key_id
}

# ─────────────────────────────────────────────────────────────
# Security Groups (Chained Least Privilege)
# ─────────────────────────────────────────────────────────────

# 1. ALB Security Group (Public facing)
resource "aws_security_group" "alb" {
  name        = "amrutam-${var.environment}-alb-sg"
  description = "Controls public inbound traffic to Application Load Balancer"
  vpc_id      = var.vpc_id

  ingress {
    description = "HTTP ingress (redirected to HTTPS)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS ingress from internet"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "Outbound traffic to VPC"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "amrutam-${var.environment}-alb-sg"
  }
}

# 2. ECS Tasks Security Group (Inbound from ALB only)
resource "aws_security_group" "ecs_tasks" {
  name        = "amrutam-${var.environment}-ecs-tasks-sg"
  description = "Allows inbound traffic only from ALB"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Allow traffic from ALB on container port"
    from_port       = var.api_container_port
    to_port         = var.api_container_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    description = "Allow outbound to internet via NAT Gateway"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "amrutam-${var.environment}-ecs-tasks-sg"
  }
}

# 3. RDS Postgres Security Group (Inbound from ECS Tasks only)
resource "aws_security_group" "rds" {
  name        = "amrutam-${var.environment}-rds-sg"
  description = "Controls inbound traffic to PostgreSQL database"
  vpc_id      = var.vpc_id

  ingress {
    description     = "PostgreSQL port from ECS Tasks"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_tasks.id]
  }

  egress {
    description = "Outbound rule"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "amrutam-${var.environment}-rds-sg"
  }
}

# 4. ElastiCache Redis Security Group (Inbound from ECS Tasks only)
resource "aws_security_group" "elasticache" {
  name        = "amrutam-${var.environment}-elasticache-sg"
  description = "Controls inbound traffic to Redis cluster"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Redis port from ECS Tasks"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_tasks.id]
  }

  egress {
    description = "Outbound rule"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "amrutam-${var.environment}-elasticache-sg"
  }
}

# ─────────────────────────────────────────────────────────────
# IAM Roles (Least Privilege)
# ─────────────────────────────────────────────────────────────

# ECS Task Execution Role (Pull image from ECR/GHCR, fetch secrets from Secrets Manager)
resource "aws_iam_role" "ecs_execution" {
  name = "amrutam-${var.environment}-ecs-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution_base" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_policy" "ecs_execution_secrets" {
  name        = "amrutam-${var.environment}-ecs-execution-secrets"
  description = "Allow ECS task execution to read secrets and decrypt with KMS"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "ssm:GetParameters"
        ]
        Resource = "arn:aws:secretsmanager:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:secret:amrutam/${var.environment}/*"
      },
      {
        Effect = "Allow"
        Action = [
          "kms:Decrypt"
        ]
        Resource = aws_kms_key.main.arn
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution_secrets" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = aws_iam_policy.ecs_execution_secrets.arn
}

# ECS Task Role (Runtime permissions for the running application)
resource "aws_iam_role" "ecs_task" {
  name = "amrutam-${var.environment}-ecs-task-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_policy" "ecs_task_runtime" {
  name        = "amrutam-${var.environment}-ecs-task-runtime"
  description = "Least privilege runtime policy for Amrutam application tasks"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:/ecs/amrutam-${var.environment}/*"
      },
      {
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey"
        ]
        Resource = aws_kms_key.main.arn
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_task_runtime" {
  role       = aws_iam_role.ecs_task.name
  policy_arn = aws_iam_policy.ecs_task_runtime.arn
}
