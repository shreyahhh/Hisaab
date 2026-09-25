# 0005. Host in AWS ap-south-1 (Mumbai) for data residency

## Status
Accepted (fixed in SPEC §3, §5.9)

## Context
SPEC §5.9 requires all personal data to stay in India, with transfers only to Meta/Google as hashed identifiers for the consented measurement purpose. The target customers are Indian D2C brands.

## Decision
- All compute and data stores run in **AWS ap-south-1**: ECS Fargate, RDS, ElastiCache, ClickHouse (EC2 or ClickHouse Cloud in ap-south-1, ADR-0013), S3, KMS, Secrets Manager. Private subnets, VPC endpoints, NAT for outbound (HLD §7).
- Observability: **Grafana Cloud in AWS ap-south-1**.
- **Exception (pending counsel)**: error tracking on **Sentry SaaS, EU region** (Sentry offers only US/EU), PII-free by design with strict scrubbing (SPEC v0.5 §3).
- Auth is self-hosted (ADR-0012), so it has no foreign sub-processor.

## Consequences
- Residency is met for all personal data. The only cross-border personal-data flow is hashed identifiers to Meta CAPI (and the encrypted IP/UA fallback, if ever approved — meta-integration §4.7).
- Vendor choices are constrained to India-available regions (Datadog was rejected for having no India site; `docs/dpdp/subprocessors.md`).
- The Sentry exception must be signed off by counsel before launch, or replaced by self-hosted Sentry in ap-south-1.
