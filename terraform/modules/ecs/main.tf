data "aws_region" "current" {}

# ECS Cluster with Container Insights enabled
resource "aws_ecs_cluster" "main" {
  name = "amrutam-${var.environment}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = {
    Name = "amrutam-${var.environment}-cluster"
  }
}

# CloudWatch Log Groups (Encrypted with KMS CMK)
resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/amrutam-${var.environment}/api"
  retention_in_days = 30
  kms_key_id        = var.kms_key_arn

  tags = {
    Name = "amrutam-${var.environment}-api-logs"
  }
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/amrutam-${var.environment}/worker"
  retention_in_days = 30
  kms_key_id        = var.kms_key_arn

  tags = {
    Name = "amrutam-${var.environment}-worker-logs"
  }
}

# ─────────────────────────────────────────────────────────────
# API Task Definition & Service
# ─────────────────────────────────────────────────────────────

resource "aws_ecs_task_definition" "api" {
  family                   = "amrutam-${var.environment}-api"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.task_role_arn

  container_definitions = jsonencode([
    {
      name      = "api"
      image     = var.image_uri
      essential = true
      command   = ["node", "dist/src/main.js"]

      portMappings = [
        {
          containerPort = 3000
          hostPort      = 3000
          protocol      = "tcp"
        }
      ]

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "PORT", value = "3000" },
        { name = "DATABASE_URL", value = var.database_url },
        { name = "REDIS_URL", value = var.redis_url },
        { name = "OTEL_SERVICE_NAME", value = "amrutam-api" }
      ]

      secrets = [
        {
          name      = "DB_CREDENTIALS"
          valueFrom = var.db_secret_arn
        },
        {
          name      = "REDIS_AUTH"
          valueFrom = var.redis_secret_arn
        }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.api.name
          "awslogs-region"        = data.aws_region.current.name
          "awslogs-stream-prefix" = "api"
        }
      }

      healthCheck = {
        command     = ["CMD-SHELL", "wget --quiet --tries=1 --spider http://localhost:3000/healthz || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 15
      }
    }
  ])

  tags = {
    Name = "amrutam-${var.environment}-api-task"
  }
}

resource "aws_ecs_service" "api" {
  name                              = "amrutam-${var.environment}-api"
  cluster                           = aws_ecs_cluster.main.id
  task_definition                   = aws_ecs_task_definition.api.arn
  desired_count                     = 2
  launch_type                       = "FARGATE"
  platform_version                  = "1.4.0"
  health_check_grace_period_seconds = 60

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = var.security_group_ids
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = var.target_group_arn
    container_name   = "api"
    container_port   = 3000
  }

  deployment_controller {
    type = "ECS"
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  tags = {
    Name = "amrutam-${var.environment}-api-service"
  }

  lifecycle {
    ignore_changes = [desired_count]
  }
}

# ─────────────────────────────────────────────────────────────
# Worker Task Definition & Service
# ─────────────────────────────────────────────────────────────

resource "aws_ecs_task_definition" "worker" {
  family                   = "amrutam-${var.environment}-worker"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.worker_cpu
  memory                   = var.worker_memory
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.task_role_arn

  container_definitions = jsonencode([
    {
      name      = "worker"
      image     = var.image_uri
      essential = true
      command   = ["node", "dist/src/worker.js"]

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "DATABASE_URL", value = var.database_url },
        { name = "REDIS_URL", value = var.redis_url },
        { name = "OTEL_SERVICE_NAME", value = "amrutam-worker" }
      ]

      secrets = [
        {
          name      = "DB_CREDENTIALS"
          valueFrom = var.db_secret_arn
        },
        {
          name      = "REDIS_AUTH"
          valueFrom = var.redis_secret_arn
        }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.worker.name
          "awslogs-region"        = data.aws_region.current.name
          "awslogs-stream-prefix" = "worker"
        }
      }
    }
  ])

  tags = {
    Name = "amrutam-${var.environment}-worker-task"
  }
}

resource "aws_ecs_service" "worker" {
  name             = "amrutam-${var.environment}-worker"
  cluster          = aws_ecs_cluster.main.id
  task_definition  = aws_ecs_task_definition.worker.arn
  desired_count    = 1
  launch_type      = "FARGATE"
  platform_version = "1.4.0"

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = var.security_group_ids
    assign_public_ip = false
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  tags = {
    Name = "amrutam-${var.environment}-worker-service"
  }
}

# ─────────────────────────────────────────────────────────────
# Autoscaling (API Service: Min 2, Max 10)
# ─────────────────────────────────────────────────────────────

resource "aws_appautoscaling_target" "api" {
  max_capacity       = 10
  min_capacity       = 2
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

# CPU Target Tracking Policy (70%)
resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "amrutam-${var.environment}-api-cpu-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  service_namespace  = aws_appautoscaling_target.api.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 70.0
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}

# Memory Target Tracking Policy (70%)
resource "aws_appautoscaling_policy" "api_memory" {
  name               = "amrutam-${var.environment}-api-memory-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  service_namespace  = aws_appautoscaling_target.api.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageMemoryUtilization"
    }
    target_value       = 70.0
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}
