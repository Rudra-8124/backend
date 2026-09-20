terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.65"
    }
  }

  # S3 remote backend configuration example (configured via backend-config in CI/CD)
  # backend "s3" {
  #   bucket         = "amrutam-telemedicine-tfstate"
  #   key            = "production/terraform.tfstate"
  #   region         = "ap-south-1"
  #   dynamodb_table = "amrutam-tfstate-locks"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "Amrutam-Telemedicine"
      Environment = var.environment
      ManagedBy   = "Terraform"
    }
  }
}
