# Research: Terraform Remote State — S3 Backend, Locking, Encryption, Sensitive Outputs, Lockfile

**Topic:** Terraform production IaC hygiene — S3 remote backend with DynamoDB (or native S3) locking, encryption at rest, `sensitive = true` on secret outputs, module versioning, environment-specific tfvars, no hardcoded credentials, `.terraform.lock.hcl` commit.
**Date:** 2026-04-08
**Agent:** infra-expert

## Sources
- [Terraform Docs: Backend Type — s3](https://developer.hashicorp.com/terraform/language/backend/s3)
- [Terraform Docs: Dependency Lock File (.terraform.lock.hcl)](https://developer.hashicorp.com/terraform/language/files/dependency-lock)
- [Terraform Docs: Lock and upgrade provider versions](https://developer.hashicorp.com/terraform/tutorials/configuration-language/provider-versioning)
- [Terraform Docs: Sensitive input variables](https://developer.hashicorp.com/terraform/tutorials/configuration-language/sensitive-variables)
- [AWS Prescriptive Guidance: Terraform backend best practices](https://docs.aws.amazon.com/prescriptive-guidance/latest/terraform-aws-provider-best-practices/backend.html)
- [AWS Well-Architected: Infrastructure as Code pillar](https://docs.aws.amazon.com/wellarchitected/latest/devops-guidance/devops-guidance.html)
- [OpenTofu Docs: S3 Backend](https://opentofu.org/docs/language/settings/backends/s3/)
- [HashiCorp Blog: Terraform 1.11 native S3 state locking](https://www.hashicorp.com/blog/terraform-1-11-introduces-native-s3-state-locking)
- [Spacelift: Terraform S3 Backend Best Practices](https://spacelift.io/blog/terraform-s3-backend)
- [CIS AWS Foundations Benchmark](https://www.cisecurity.org/benchmark/amazon_web_services)

## Key Findings

1. **Remote backend is non-negotiable.** Local `terraform.tfstate` on a developer laptop = CRITICAL (lost state = unrecoverable infra; no team collaboration; secrets on disk in cleartext). Production Terraform MUST use S3 + locking, Terraform Cloud, or equivalent (GCS, Azure Blob).

2. **S3 backend configuration (AWS).**
   ```hcl
   terraform {
     required_version = ">= 1.11"
     backend "s3" {
       bucket         = "company-tfstate-prod"
       key            = "env/prod/network.tfstate"
       region         = "eu-west-1"
       encrypt        = true
       kms_key_id     = "arn:aws:kms:eu-west-1:123456789012:key/..."
       use_lockfile   = true              # native S3 locking (Terraform 1.11+, AWS provider 5.x+)
       # dynamodb_table = "tfstate-lock"   # legacy; deprecated in favor of use_lockfile
     }
   }
   ```
   Missing `encrypt = true` = CRITICAL. Missing locking (DynamoDB or `use_lockfile`) = CRITICAL (concurrent apply corruption).

3. **State locking evolution (2025-2026).** DynamoDB-based locking is deprecated. Terraform 1.11 + AWS provider v5+ supports `use_lockfile = true` for native S3 conditional-write locking — no DynamoDB table needed. For migration, keep both DynamoDB and `use_lockfile` temporarily. New projects should use `use_lockfile` only.

4. **S3 bucket hardening for state:**
   - **Versioning enabled** (recover from accidental delete / corruption)
   - **Default encryption with customer-managed KMS key** (not SSE-S3 default)
   - **Bucket policy denies non-TLS** (`aws:SecureTransport: false` → deny)
   - **Block public access (all 4 settings)**
   - **MFA delete** on the bucket (optional but recommended for prod)
   - **Object lock / Glacier lifecycle for audit retention**
   - **CloudTrail data events** enabled for GetObject/PutObject on state keys
   - **Cross-region replication** for DR

5. **One state file per environment, per component.** Monolithic state = blast radius disaster. Pattern:
   ```
   s3://company-tfstate-prod/
     env/dev/network.tfstate
     env/dev/eks.tfstate
     env/dev/rds.tfstate
     env/prod/network.tfstate
     env/prod/eks.tfstate
     env/prod/rds.tfstate
   ```
   Plus `bootstrap/` for the state bucket itself (chicken-and-egg — usually created once with local state then imported).

6. **`sensitive = true` on ALL secret variables AND outputs.**
   ```hcl
   variable "db_password" {
     type      = string
     sensitive = true
   }
   
   output "rds_connection_string" {
     value     = "postgres://user:${aws_db_instance.main.password}@..."
     sensitive = true
   }
   ```
   Sensitive values are redacted in CLI output but STILL PRESENT in the state file (cleartext). Hence state bucket MUST be encrypted + access-controlled. Missing `sensitive = true` = HIGH (leaks in CI logs).

7. **Never hardcode credentials in .tf files.** No `access_key = "AKIA..."` or `password = "..."`. Use:
   - Environment variables: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
   - AWS SSO / IAM Identity Center profiles
   - IRSA (IAM roles for service accounts) in CI runners
   - Assume-role via OIDC from GitHub Actions (`aws-actions/configure-aws-credentials` + OIDC trust)
   Hardcoded creds = CRITICAL.

8. **Module versioning with explicit source + version.**
   ```hcl
   module "vpc" {
     source  = "terraform-aws-modules/vpc/aws"
     version = "5.8.1"   # pinned, not ">= 5.0"
     ...
   }
   ```
   Unpinned module versions = HIGH (reproducibility broken). Use `>=` only for sub-modules maintained in-org where semver is strictly followed.

9. **Environment-specific tfvars, NOT branching Terraform configs.**
   ```
   environments/
     dev.tfvars
     staging.tfvars
     prod.tfvars
   ```
   Invoke with `terraform apply -var-file=environments/prod.tfvars`. Secrets come from env vars or Vault dynamic, not tfvars files. Checking a `*.tfvars` file with secrets into Git = CRITICAL.

10. **`.terraform.lock.hcl` MUST be committed.** Tracks provider versions + checksums (`h1:` hashes). Without it, `terraform init` picks newest compatible → non-reproducible builds across team + CI. Missing from Git = HIGH.

11. **Provider version constraints with explicit upper bound.**
    ```hcl
    terraform {
      required_version = ">= 1.11, < 2.0"
      required_providers {
        aws = {
          source  = "hashicorp/aws"
          version = "~> 5.80"   # allows 5.80.x, not 6.x
        }
      }
    }
    ```

12. **State file access audit.** Enable CloudTrail data events on state bucket. Alert on `PutObject` outside of approved CI runner roles.

13. **Drift detection.** Weekly `terraform plan` against production (read-only, no apply) with alert on non-empty diff. Manual AWS console changes are the #1 source of state drift.

14. **Zero-trust runner identity.** CI runners that apply Terraform MUST use short-lived credentials (OIDC trust, IRSA) — never long-lived IAM user keys stored in GitHub Secrets.

## Security Concerns
- Local state file for production = CRITICAL.
- Missing `encrypt = true` on S3 backend = CRITICAL.
- Missing state locking (DynamoDB or `use_lockfile`) = CRITICAL.
- Hardcoded AWS credentials in .tf files = CRITICAL.
- tfvars file with secrets committed to Git = CRITICAL.
- Missing `sensitive = true` on secret variables/outputs = HIGH.
- State bucket with public access = CRITICAL.
- State bucket without versioning = HIGH.
- State bucket without CloudTrail data events = MEDIUM.
- Module source pointing to `git::` without `?ref=<sha>` pinning = HIGH.
- Provider block without version constraint = HIGH.
- Missing `.terraform.lock.hcl` in Git = HIGH.
- Long-lived IAM user credentials in CI = HIGH (prefer OIDC).

## Operational Concerns
- Single monolithic state file covering all environments = HIGH (blast radius).
- Missing drift detection = MEDIUM.
- No backup / cross-region replication of state bucket = MEDIUM.
- `terraform apply` directly on main branch without PR review = HIGH (change management).

## Architectural Implications for infra-expert reviews
- Every Terraform root module MUST have a remote backend with encryption + locking.
- Every secret variable/output MUST be marked `sensitive = true`.
- Every `module` block MUST pin `version` (or `?ref=<sha>` for git sources).
- Every provider MUST have a version constraint with upper bound.
- `.terraform.lock.hcl` MUST be committed.
- No credentials in .tf or checked-in .tfvars.
- CI Terraform runners MUST use short-lived credentials (OIDC).

## Domain Rule Additions for infra-expert

Add to `## Domain Rules → Terraform`:
- Remote backend with encryption (`encrypt = true`) + KMS + locking (`use_lockfile = true` or DynamoDB) is MANDATORY; local state or missing encryption = CRITICAL.
- State bucket MUST have versioning, public access blocked, bucket policy denying non-TLS, CloudTrail data events; missing any = HIGH.
- Each environment and component gets its own state file; monolithic state = HIGH.
- Every secret variable AND output MUST be marked `sensitive = true`; missing = HIGH.
- Credentials MUST come from environment, OIDC, or IRSA — never hardcoded in `.tf` or `.tfvars`; hardcoded = CRITICAL.
- Module sources MUST pin `version` (registry) or `?ref=<commit-sha>` (git); unpinned = HIGH.
- Provider blocks MUST have version constraints with upper bound (`~> 5.80`); missing upper bound = MEDIUM.
- `.terraform.lock.hcl` MUST be committed to Git; missing = HIGH.
- CI Terraform runners MUST use short-lived credentials via OIDC/IRSA; static IAM user keys = HIGH.
- Production applies MUST go through PR review with a plan attached; direct apply = HIGH.
- Weekly drift detection SHOULD run against production with alerting; missing = MEDIUM.
