# ─────────────────────────────────────────────────────────────
# 1. Network Module (VPC, Multi-AZ Subnets, NAT, IGW)
# ─────────────────────────────────────────────────────────────
module "network" {
  source = "./modules/network"

  environment        = var.environment
  vpc_cidr           = var.vpc_cidr
  availability_zones = var.availability_zones
}

# ─────────────────────────────────────────────────────────────
# 2. Security Module (KMS CMK, IAM Least Privilege, SGs)
# ─────────────────────────────────────────────────────────────
module "security" {
  source = "./modules/security"

  environment = var.environment
  vpc_id      = module.network.vpc_id
}

# ─────────────────────────────────────────────────────────────
# 3. RDS Postgres 16 Multi-AZ Module (Encrypted, 14-day PITR)
# ─────────────────────────────────────────────────────────────
module "rds" {
  source = "./modules/rds"

  environment        = var.environment
  subnet_ids         = module.network.data_subnet_ids
  security_group_ids = [module.security.rds_security_group_id]
  kms_key_arn        = module.security.kms_key_arn
  instance_class     = var.rds_instance_class
  database_name      = "amrutam"
}

# ─────────────────────────────────────────────────────────────
# 4. ElastiCache Redis 7 Multi-AZ Module (In-transit & At-rest encryption)
# ─────────────────────────────────────────────────────────────
module "elasticache" {
  source = "./modules/elasticache"

  environment        = var.environment
  subnet_ids         = module.network.data_subnet_ids
  security_group_ids = [module.security.elasticache_security_group_id]
  kms_key_arn        = module.security.kms_key_arn
  node_type          = var.elasticache_node_type
}

# ─────────────────────────────────────────────────────────────
# 5. Application Load Balancer Module (HTTPS TLS 1.2+, Health Check)
# ─────────────────────────────────────────────────────────────
module "alb" {
  source = "./modules/alb"

  environment        = var.environment
  vpc_id             = module.network.vpc_id
  public_subnet_ids  = module.network.public_subnet_ids
  security_group_ids = [module.security.alb_security_group_id]
  certificate_arn    = var.certificate_arn
  container_port     = 3000
}

# ─────────────────────────────────────────────────────────────
# 6. ECS Fargate Services Module (API, Worker, Autoscaling)
# ─────────────────────────────────────────────────────────────
module "ecs" {
  source = "./modules/ecs"

  environment        = var.environment
  subnet_ids         = module.network.app_subnet_ids
  security_group_ids = [module.security.ecs_tasks_security_group_id]
  target_group_arn   = module.alb.target_group_arn
  execution_role_arn = module.security.ecs_execution_role_arn
  task_role_arn      = module.security.ecs_task_role_arn
  kms_key_arn        = module.security.kms_key_arn
  image_uri          = var.image_uri

  db_secret_arn    = module.rds.secret_arn
  redis_secret_arn = module.elasticache.auth_token_secret_arn

  database_url = "postgresql://amrutam_admin@${module.rds.address}:${module.rds.port}/${module.rds.database_name}?sslmode=require"
  redis_url    = "rediss://:${module.elasticache.primary_endpoint_address}:${module.elasticache.port}"
}

# ─────────────────────────────────────────────────────────────
# 7. CloudWatch Alarms & Monitoring Module
# ─────────────────────────────────────────────────────────────
module "monitoring" {
  source = "./modules/monitoring"

  environment             = var.environment
  ecs_cluster_name        = module.ecs.cluster_name
  ecs_api_service_name    = module.ecs.api_service_name
  rds_instance_id         = "amrutam-${var.environment}-postgres"
  elasticache_cluster_id  = "amrutam-${var.environment}-redis"
  alb_arn_suffix          = module.alb.alb_arn
  target_group_arn_suffix = module.alb.target_group_arn
}
