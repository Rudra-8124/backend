output "vpc_id" {
  description = "ID of the VPC"
  value       = aws_vpc.main.id
}

output "vpc_cidr_block" {
  description = "CIDR block of the VPC"
  value       = aws_vpc.main.cidr_block
}

output "public_subnet_ids" {
  description = "List of IDs of public subnets"
  value       = aws_subnet.public[*].id
}

output "app_subnet_ids" {
  description = "List of IDs of private application subnets"
  value       = aws_subnet.app[*].id
}

output "data_subnet_ids" {
  description = "List of IDs of private data subnets"
  value       = aws_subnet.data[*].id
}
