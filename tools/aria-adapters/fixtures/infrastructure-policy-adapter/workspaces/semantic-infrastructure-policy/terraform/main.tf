# The semantic corpus Terraform: one pinned and one unpinned twin per module source form,
# nested blocks, and the comment decoys.

# UNSAFE TWIN: a git source on a branch.
module "branch" {
  source = "git::https://git.example.test/vpc.git?ref=main"
}

# SAFE TWIN: a git source on a commit.
module "commit" {
  source = "git::https://git.example.test/vpc.git?ref=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
}

# UNSAFE TWIN: a registry module without a version.
module "registry_bare" {
  source = "terraform-aws-modules/vpc/aws"
}

# SAFE TWIN: a registry module with a version.
module "registry" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.1.2"
}

# UNSAFE TWIN: an archive without a checksum; the object behind the URL can be replaced.
module "archive" {
  source = "https://artifacts.example.test/vpc.zip"
}

# SAFE TWIN: the same archive with a go-getter checksum.
module "checksummed" {
  source = "https://artifacts.example.test/vpc.zip?checksum=sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
}

# SAFE TWIN: a local module, with nested blocks.
module "platform" {
  source = "./modules/platform"

  database {
    engine = "postgres"
    storage {
      encrypted = true
    }
  }
}

# UNRESOLVED TWIN: an address form the owner does not classify is never counted as pinned.
module "mirror" {
  source = "ftp-mirror:vpc"
}

# DECOYS: a commented module and a block comment never configure anything.
# module "commented" { source = "git::https://git.example.test/old.git" }
/* module "block_commented" { source = "git::https://git.example.test/old.git" } */
