# ustawienie credentials (windows)
# $env:TF_VAR_aws_access_key_id = (aws configure get aws_access_key_id)
# $env:TF_VAR_aws_secret_access_key = (aws configure get aws_secret_access_key)
# $env:TF_VAR_aws_session_token = (aws configure get aws_session_token)

# ustawienie credentials (linux)
# export TF_VAR_aws_access_key_id=$(aws configure get aws_access_key_id)
# export TF_VAR_aws_secret_access_key=$(aws configure get aws_secret_access_key)
# export TF_VAR_aws_session_token=$(aws configure get aws_session_token)

# Konfiguracja providera AWS
provider "aws" {
  region = "us-east-1"
}

# Zmienne
variable "app_name" {
  description = "App name"
  default     = "notes-app"
}

variable "db_username" {
  description = "Username for RDS database"
  default     = "dbadmin"
}

variable "aws_access_key_id" {
  description = "aws_access_key_id"
  default     = ""
}

variable "aws_secret_access_key" {
  description = "aws_secret_access_key"
  default     = ""
}

variable "aws_session_token" {
  description = "aws_session_token"
  default     = ""
}

variable "db_password" {
  description = "Password for RDS database"
  sensitive   = true

  default = "YourStrongPasswordHere"
}

variable "frontend_docker_image" {
  description = "Docker image for the frontend"
  default     = "264019/notes-app-frontend:latest"
}

variable "backend_docker_image" {
  description = "Docker image for the backend"
  default     = "264019/notes-app-backend:latest"
}


resource "random_string" "suffix" {
  length  = 6
  special = false
  upper   = false
}

# Bucket S3 do przechowywania plików
resource "aws_s3_bucket" "app_bucket" {
  bucket = "${var.app_name}-files-bucket-${random_string.suffix.result}"
}


# Konfiguracja dostępu publicznego do bucketa
resource "aws_s3_bucket_public_access_block" "app_bucket_access" {
  bucket = aws_s3_bucket.app_bucket.id
}

resource "aws_s3_bucket_ownership_controls" "app_bucket_ownership" {
  bucket = aws_s3_bucket.app_bucket.id

  rule {
    object_ownership = "BucketOwnerPreferred"
  }
}

resource "aws_s3_bucket_acl" "app_bucket_acl" {
  bucket = aws_s3_bucket.app_bucket.id
  acl    = "public-read-write"

  depends_on = [
    aws_s3_bucket_ownership_controls.app_bucket_ownership,
    aws_s3_bucket_public_access_block.app_bucket_access,
  ]
}

# Konfiguracja bazy danych RDS
resource "aws_db_instance" "app_db" {
  allocated_storage    = 20
  engine               = "postgres"
  engine_version       = "17.2"
  instance_class       = "db.t3.micro"
  db_name              = "notesdb"
  username             = var.db_username
  password             = var.db_password
  parameter_group_name = "test"
  skip_final_snapshot  = true
  publicly_accessible  = true
}

# Cognito User Pool
resource "aws_cognito_user_pool" "app_user_pool" {
  name = "${var.app_name}-user-pool"

  auto_verified_attributes = ["email"]
}

# Cognito User Pool Client
resource "aws_cognito_user_pool_client" "app_client" {
  name         = "${var.app_name}-client"
  user_pool_id = aws_cognito_user_pool.app_user_pool.id

  generate_secret = false
  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_SRP_AUTH"
  ]
}

# Elastic Beanstalk Application
resource "aws_elastic_beanstalk_application" "app" {
  name = var.app_name
}

# S3 bucket dla wersji aplikacji
resource "aws_s3_bucket" "app_versions" {
  bucket = "${var.app_name}-app-versions"
}

# Backend Dockerrun.aws.json file
resource "aws_s3_object" "backend_dockerrun" {
  bucket = aws_s3_bucket.app_versions.id
  key    = "backend-dockerrun.aws.json"
  content = jsonencode({
    AWSEBDockerrunVersion = "1",
    Image = {
      Name   = var.backend_docker_image,
      Update = "true"
    },
    Ports = [
      {
        ContainerPort = "8080",
        HostPort      = "8080"
      }
    ]
  })
}

# Frontend Dockerrun.aws.json file
resource "aws_s3_object" "frontend_dockerrun" {
  bucket = aws_s3_bucket.app_versions.id
  key    = "frontend-dockerrun.aws.json"
  content = jsonencode({
    AWSEBDockerrunVersion = "1",
    Image = {
      Name   = var.frontend_docker_image,
      Update = "true"
    },
    Ports = [
      {
        ContainerPort = "80",
        HostPort      = "80"
      }
    ]
  })
}

# Backend Application Version
resource "aws_elastic_beanstalk_application_version" "backend_version" {
  name        = "${var.app_name}-backend-version"
  application = aws_elastic_beanstalk_application.app.name
  bucket      = aws_s3_bucket.app_versions.id
  key         = aws_s3_object.backend_dockerrun.id
}

# Frontend Application Version
resource "aws_elastic_beanstalk_application_version" "frontend_version" {
  name        = "${var.app_name}-frontend-version"
  application = aws_elastic_beanstalk_application.app.name
  bucket      = aws_s3_bucket.app_versions.id
  key         = aws_s3_object.frontend_dockerrun.id
}

# Elastic Beanstalk Backend Environment
resource "aws_elastic_beanstalk_environment" "backend_env" {
  name                = "${var.app_name}-backend-env"
  application         = aws_elastic_beanstalk_application.app.name
  solution_stack_name = "64bit Amazon Linux 2023 v4.5.0 running Docker"
  version_label       = aws_elastic_beanstalk_application_version.backend_version.name

  setting {
    namespace = "aws:elasticbeanstalk:application:environment"
    name      = "PORT"
    value     = "8080"
  }

  setting {
    namespace = "aws:elasticbeanstalk:application:environment"
    name      = "DB_URL"
    value     = "postgres://${var.db_username}:${var.db_password}@${aws_db_instance.app_db.endpoint}/notesdb"
  }

  setting {
    namespace = "aws:elasticbeanstalk:application:environment"
    name      = "AWS_REGION"
    value     = "us-east-1"
  }

  setting {
    namespace = "aws:elasticbeanstalk:application:environment"
    name      = "AWS_ACCESS_KEY_ID"
    value     = var.aws_access_key_id
  }

  setting {
    namespace = "aws:elasticbeanstalk:application:environment"
    name      = "AWS_SECRET_ACCESS_KEY"
    value     = var.aws_secret_access_key
  }

  setting {
    namespace = "aws:elasticbeanstalk:application:environment"
    name      = "AWS_SESSION_TOKEN"
    value     = var.aws_session_token
  }

  setting {
    namespace = "aws:elasticbeanstalk:application:environment"
    name      = "AWS_BUCKET_NAME"
    value     = aws_s3_bucket.app_bucket.bucket
  }

  setting {
    namespace = "aws:elasticbeanstalk:application:environment"
    name      = "COGNITO_CLIENT_ID"
    value     = aws_cognito_user_pool_client.app_client.id
  }

  setting {
    namespace = "aws:elasticbeanstalk:application:environment"
    name      = "COGNITO_USER_POOL_ID"
    value     = aws_cognito_user_pool.app_user_pool.id
  }

  setting {
    namespace = "aws:elasticbeanstalk:application:environment"
    name      = "APP_NAME"
    value     = var.app_name
  }

  setting {
    namespace = "aws:autoscaling:launchconfiguration"
    name      = "IamInstanceProfile"
    value     = "LabInstanceProfile"
  }
}

# Elastic Beanstalk Frontend Environment
resource "aws_elastic_beanstalk_environment" "frontend_env" {
  name                = "${var.app_name}-frontend-env"
  application         = aws_elastic_beanstalk_application.app.name
  solution_stack_name = "64bit Amazon Linux 2023 v4.5.0 running Docker"
  version_label       = aws_elastic_beanstalk_application_version.frontend_version.name

  setting {
    namespace = "aws:elasticbeanstalk:application:environment"
    name      = "VITE_API_URL"
    value     = "http://${aws_elastic_beanstalk_environment.backend_env.cname}"
  }

  setting {
    namespace = "aws:autoscaling:launchconfiguration"
    name      = "IamInstanceProfile"
    value     = "LabInstanceProfile"
  }
}

# Outputs
output "backend_url" {
  value = "http://${aws_elastic_beanstalk_environment.backend_env.cname}"
}

output "frontend_url" {
  value = "http://${aws_elastic_beanstalk_environment.frontend_env.cname}"
}

output "database_endpoint" {
  value = aws_db_instance.app_db.endpoint
}

output "s3_bucket" {
  value = aws_s3_bucket.app_bucket.bucket
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.app_user_pool.id
}

output "cognito_client_id" {
  value = aws_cognito_user_pool_client.app_client.id
}
