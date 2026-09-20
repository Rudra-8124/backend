# SNS Topic for Critical Production Alarms
resource "aws_sns_topic" "alerts" {
  name = "amrutam-${var.environment}-alerts"

  tags = {
    Name = "amrutam-${var.environment}-alerts"
  }
}

# 1. ECS API High CPU Alarm (>80% for 3 periods of 60s)
resource "aws_cloudwatch_metric_alarm" "ecs_cpu_high" {
  alarm_name          = "amrutam-${var.environment}-ecs-api-high-cpu"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = 60
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "ECS API Service CPU utilization exceeded 80%"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  dimensions = {
    ClusterName = var.ecs_cluster_name
    ServiceName = var.ecs_api_service_name
  }
}

# 2. ECS API High Memory Alarm (>80% for 3 periods of 60s)
resource "aws_cloudwatch_metric_alarm" "ecs_memory_high" {
  alarm_name          = "amrutam-${var.environment}-ecs-api-high-memory"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "MemoryUtilization"
  namespace           = "AWS/ECS"
  period              = 60
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "ECS API Service Memory utilization exceeded 80%"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  dimensions = {
    ClusterName = var.ecs_cluster_name
    ServiceName = var.ecs_api_service_name
  }
}

# 3. RDS High CPU Alarm (>80% for 3 periods of 60s)
resource "aws_cloudwatch_metric_alarm" "rds_cpu_high" {
  alarm_name          = "amrutam-${var.environment}-rds-high-cpu"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 60
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "RDS PostgreSQL CPU utilization exceeded 80%"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  dimensions = {
    DBInstanceIdentifier = var.rds_instance_id
  }
}

# 4. RDS Low Free Storage Space (< 10GB for 2 periods of 300s)
resource "aws_cloudwatch_metric_alarm" "rds_storage_low" {
  alarm_name          = "amrutam-${var.environment}-rds-low-storage"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "FreeStorageSpace"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 10737418240 # 10 GB in bytes
  alarm_description   = "RDS PostgreSQL free storage space fell below 10GB"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  dimensions = {
    DBInstanceIdentifier = var.rds_instance_id
  }
}

# 5. RDS High Database Connections (>85% saturation)
resource "aws_cloudwatch_metric_alarm" "rds_connections_high" {
  alarm_name          = "amrutam-${var.environment}-rds-high-connections"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "DatabaseConnections"
  namespace           = "AWS/RDS"
  period              = 60
  statistic           = "Average"
  threshold           = 400
  alarm_description   = "RDS PostgreSQL connection count reached saturation limit"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  dimensions = {
    DBInstanceIdentifier = var.rds_instance_id
  }
}

# 6. ALB High 5XX Error Rate (>1% or count >10 per min)
resource "aws_cloudwatch_metric_alarm" "alb_5xx_errors" {
  alarm_name          = "amrutam-${var.environment}-alb-5xx-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Sum"
  threshold           = 10
  alarm_description   = "ALB target group experienced elevated 5XX server errors"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  dimensions = {
    LoadBalancer = var.alb_arn_suffix
    TargetGroup  = var.target_group_arn_suffix
  }
}

# 7. ElastiCache Redis High CPU Alarm (>80%)
resource "aws_cloudwatch_metric_alarm" "redis_cpu_high" {
  alarm_name          = "amrutam-${var.environment}-redis-high-cpu"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "EngineCPUUtilization"
  namespace           = "AWS/ElastiCache"
  period              = 60
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "Redis engine CPU utilization exceeded 80%"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  dimensions = {
    CacheClusterId = "${var.elasticache_cluster_id}-001"
  }
}
