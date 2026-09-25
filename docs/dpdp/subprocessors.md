# Sub-processors (SPEC §5.5 S-7)

> Engineering draft. Counsel finalises the list and the DPA wording (SPEC M0-7). Merchants (the Data Fiduciaries) must be notified before a sub-processor is added or changed.

## Sub-processors that process personal data

| Sub-processor | Service | Purpose | Personal data | Location | Status |
|---|---|---|---|---|---|
| Amazon Web Services India Pvt. Ltd. / AWS | ECS Fargate, RDS PostgreSQL, ElastiCache, EC2, S3, KMS, Secrets Manager, ALB, CloudFront, CloudWatch | Hosting, storage, encryption, logs | Hashed shopper identifiers, pseudonymous visitor ids, order records; merchant-staff account data | ap-south-1 (Mumbai) | Confirmed (SPEC §3, §5.9) |
| AWS — Amazon SES | Email | Breach notifications and DSR status emails to merchant staff | Merchant-staff names and email addresses; no shopper data | ap-south-1 (Mumbai) | Approved (batch-1 review) |
| Grafana Labs (Grafana Cloud: Loki/Mimir/Tempo) | Logs, metrics, traces | Observability | None intended: no identifiers in telemetry (HLD §8 Observability) | **AWS ap-south-1 (Mumbai)** ([Grafana regions](https://grafana.com/docs/grafana-cloud/security-and-account-management/regional-availability/)) | **Chosen** (SPEC v0.5) |
| Functional Software Inc. (Sentry SaaS) | Error tracking | Exception reports | None intended. Strict scrubbing: `beforeSend` drops identifiers, query strings, form values and headers; `sendDefaultPii: false`; no session replay; no request bodies; user context is an internal user id only. | **EU (Frankfurt)**; Sentry offers only US/EU, and the location can't be changed later ([Sentry data storage](https://docs.sentry.io/organization/data-storage-location/)) | **Chosen, pending counsel sign-off** (telemetry outside India) |
| ClickHouse Inc. (ClickHouse Cloud) | Managed analytics DB | Only if ADR-0013 chooses Cloud | Events, touchpoints, identity links (hashed/pseudonymous) | **ap-south-1 (Mumbai) supported, public, no tier restriction** ([supported regions](https://clickhouse.com/docs/cloud/reference/supported-regions)) | Conditional on ADR-0013 |

**Considered and not used**
- Datadog: no India site ([Datadog sites](https://docs.datadoghq.com/getting_started/site/)).
- Clerk: a US-hosted auth sub-processor, rejected in ADR-0012. Better Auth runs self-hosted in our own Postgres (ap-south-1), so auth has **no sub-processor**.

## Recipients that are not sub-processors
- **Meta Platforms (Conversions API).** Hashed identifiers are sent on the merchant's instruction, for the consented `ad_platform_measurement` purpose (SPEC §5.9). Counsel should confirm how Meta's role is characterised in the DPA.
- **Shopify, Google Ads, Shiprocket.** Data is *read* from them on the merchant's instruction. TruePath sends no shopper personal data to Google Ads or Shiprocket in MVP.

## Libraries and data files (no data leaves our infrastructure)
Not sub-processors; listed for transparency.
- DB-IP Lite: local geolocation database file (CC BY 4.0, attribution required).
- `ua-parser-js` 1.x: local user-agent parsing (MIT).
- `@clickhouse/client`: database driver.
