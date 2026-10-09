# CI service containers hit the Docker Hub anonymous pull limit (2026-10-09)

ARIA's first PR (#1906) failed `CI - Affected` three times in a row. The `install` and
`pre-flight` jobs could not start their service containers:

```text
docker pull redis:7-alpine
Error response from daemon: toomanyrequests: You have reached your unauthenticated pull rate limit.
```

Owner: claude (implementation), okan (review). Deadline 2026-10-16.

## INFRA-HIGH-213

`ci-affected.yml` declares `redis:7-alpine` and `nats:2.10-alpine` as job services 32 times.
`ci-full.yml` and `e2e-messaging.yml` declare `redis:7` / `redis:7-alpine`. All of them pull
from Docker Hub without authentication. GitHub-hosted runners share egress IPs, so on a busy
day the anonymous Docker Hub quota is exhausted and every job with a service container fails
before running a step. The failures are not caused by the change under test, and reruns do
not clear them until the quota window resets.

Fix: every Docker Hub official image used as a CI service is pulled through the AWS ECR Public
mirror of the Docker official images (`public.ecr.aws/docker/library/<image>:<tag>`). It
serves the same images with no anonymous rate limit for this usage. Each tag was checked to
exist on the mirror (`docker manifest inspect`). The TimescaleDB service image is not a
Docker official image and is already pinned by digest, so it is unchanged.

Not changed: no Docker Hub credentials were added to CI. The mirror removes the dependency on
an anonymous quota rather than spending a token on it.
