# Fallback ACM certificate if none provided
resource "aws_acm_certificate" "cert" {
  count             = var.certificate_arn == "" ? 1 : 0
  domain_name       = "api.amrutam.internal"
  validation_method = "DNS"

  tags = {
    Name = "amrutam-${var.environment}-cert"
  }

  lifecycle {
    create_before_destroy = true
  }
}

locals {
  certificate_arn = var.certificate_arn != "" ? var.certificate_arn : aws_acm_certificate.cert[0].arn
}

# Application Load Balancer
resource "aws_lb" "main" {
  name               = "amrutam-${var.environment}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = var.security_group_ids
  subnets            = var.public_subnet_ids

  enable_deletion_protection = false # Set true in production tfvars
  drop_invalid_header_fields = true

  tags = {
    Name = "amrutam-${var.environment}-alb"
  }
}

# Target Group for ECS API Container
resource "aws_lb_target_group" "api" {
  name                 = "amrutam-${var.environment}-tg"
  port                 = var.container_port
  protocol             = "HTTP"
  vpc_id               = var.vpc_id
  target_type          = "ip"
  deregistration_delay = 30

  health_check {
    enabled             = true
    path                = "/healthz"
    port                = "traffic-port"
    protocol            = "HTTP"
    healthy_threshold   = 3
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 15
    matcher             = "200"
  }

  tags = {
    Name = "amrutam-${var.environment}-tg"
  }
}

# HTTP Listener (Redirects to HTTPS)
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# HTTPS Listener (TLS 1.2+ Security Policy)
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = local.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}
