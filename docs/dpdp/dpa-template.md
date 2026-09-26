# Data Processing Agreement (DRAFT, version `0.1-draft`)

> **Engineering draft for counsel. This is not legal advice and not a signed-off contract.** It states what the platform actually does (SPEC §5, HLD §8, the LLDs) so counsel can turn it into contract language. Items in `[square brackets]` are placeholders. Items marked **Counsel** are open questions. The version string above is what `dpa_acceptances.dpa_version` records once the accept endpoint ships (auth-tenancy.md §4.5); it must be replaced by the counsel-approved version before any production merchant accepts.

## 1. Parties and roles
- **Merchant** = the business that operates the Shopify store and installs TruePath. The Merchant is the **Data Fiduciary** for its shoppers' personal data (DPDP Act 2023; SPEC §5.1).
- **TruePath** = `[legal entity name, registered address]`. For shopper data, TruePath is a **Data Processor** acting on the Merchant's documented instructions.
- **For Merchant staff** (people who log in to the dashboard), TruePath is itself the Data Fiduciary. Section 12 covers this.
- Accepting this DPA is a precondition for tracking. Until the current DPA version is accepted by an organisation owner, the Collector treats every store of that organisation as inactive and stores nothing (HLD §8, privacy-dpdp.md §4.10).

## 2. Subject matter, purposes and duration (Annex A)

**Purposes (the only purposes for which TruePath processes shopper data):**
| Purpose id | Description |
|---|---|
| `attribution_analytics` | Measuring which ads and channels lead to orders, including delivered and returned-to-origin outcomes. |
| `ad_platform_measurement` | Sending hashed conversion signals to Meta's Conversions API, only for shoppers who granted marketing consent and only for stores not marked child-directed. |

**Categories of shopper data:**
- A random first-party visitor id and session id (pseudonymous).
- Pages and products viewed, add-to-cart and checkout events; landing page and referrer; campaign parameters and ad click ids (`utm_*`, `fbclid`, `gclid`, `gbraid`, `wbraid`, `_fbp`, `_fbc`).
- Device type, operating system, browser, and state/city derived from the IP address. The IP address and raw user agent are **not stored**.
- Keyed hashes (tenant-scoped HMAC) of the shopper's phone number and email, used to link visits to orders. Raw phone and email are not stored in TruePath.
- Order data received from Shopify: order id, amounts, payment method (COD or prepaid), first 3 digits of the pincode, delivery status from the logistics provider, refunds.
- Consent records (hashed visitor id, purposes, notice version, time).

**Categories of Merchant-staff data (TruePath as Fiduciary):** name, email, password hash, session records (IP truncated to /24 or /48), audit-log entries.

**Duration:** for the term of the agreement plus the deletion period in section 9. Default retention of raw events is 13 months (configurable 3 to 25 months by the Merchant); order records 25 months; consent records for the life of the relationship plus 1 year; audit logs at least 1 year (SPEC §5.7).

## 3. TruePath's obligations as Processor
1. Process shopper data only on the Merchant's documented instructions, which are this DPA, the Merchant's configuration in the dashboard, and API calls made by the Merchant's authorised users.
2. Ensure everyone with access is bound by confidentiality.
3. Apply the security measures in Annex B.
4. Not process shopper data for its own purposes and not combine it across Merchants. Every read and write is scoped to a single store (ADR-0016).
5. Check consent before use: events without analytics consent are dropped at the Collector; workers re-check consent and suppression at execution time (SPEC §0 rule 3).
6. Keep records of processing and make available what the Merchant reasonably needs to show compliance, including the audit log (section 10).

## 4. Merchant's obligations as Fiduciary
The Merchant is responsible for, and warrants that it will:
1. Publish a privacy notice and consent banner that meet the DPDP Act and Rules. TruePath supplies a template (`shopper-notice.md`, English and Hindi) as a starting point only.
2. **Configure its consent banner so that India is an opt-in region** and confirm this in onboarding. TruePath keeps tracking disabled until the confirmation is given, and pauses tracking automatically if it detects widespread tracking without a consent interaction (SPEC v0.6 P-1). **Counsel:** confirm the wording of the confirmation and the allocation of responsibility if the Merchant's confirmation is wrong.
3. Mark the store as child-directed if it sells to minors. This disables Meta sendback and behavioural profiling for that store (P-6).
4. Name a grievance officer and keep the contact current in privacy settings.
5. Notify shoppers and the Data Protection Board of a breach where the law requires (section 8).
6. Have a lawful basis for the order data it sends TruePath through Shopify.

## 5. Sub-processors
- The current list is `docs/dpdp/subprocessors.md`, reproduced as Annex C at signing.
- TruePath gives the Merchant `[30]` days' notice before adding or replacing a sub-processor, by email to organisation owners; the Merchant may object within `[14]` days. **Counsel:** the notice period and the remedy if the Merchant objects.
- TruePath stays responsible for its sub-processors and binds them to terms no less protective than this DPA.
- **Meta Platforms (Conversions API)** and Shopify, Google Ads and Shiprocket are recipients or sources on the Merchant's instruction. Hashed identifiers go to Meta for the consented `ad_platform_measurement` purpose only. **Counsel:** how Meta's role is characterised.

## 6. Location of data
All shopper personal data is stored in AWS ap-south-1 (Mumbai). The only transfer outside India is hashed identifiers to Meta for the consented measurement purpose (SPEC §5.9). Telemetry sent to the error-tracking vendor (Sentry, EU region) is designed to carry no personal data. **Counsel:** sign-off on that telemetry transfer (open item in HLD §8).

## 7. Shopper rights and Merchant requests
- The dashboard's Privacy Requests page lets the Merchant submit access, erasure and correction requests by phone or email. TruePath hashes the identifier immediately and never stores the raw value.
- TruePath completes a request within **7 days** of receipt (target under 1 hour; SPEC §5.6; privacy-dpdp.md §7). Shopify's privacy webhooks (`customers/data_request`, `customers/redact`, `shop/redact`) create the same requests automatically.
- **Erasure is permanent for 13 months, across devices**: an erased shopper is not tracked again for that store during that period, and a new device that later identifies the same shopper is purged (docs/dpdp/README.md).
- **Withdrawal of analytics consent** deletes the data collected from that browser, normally within 24 hours; marketing-only withdrawal stops Meta sendback. **Counsel:** DPDP Act s.8(7) reading (open item).
- Deletion timing to disclose: hidden immediately, physically removed from disk within 7 days, gone from backups within 30 days after that. Retention clean-up in the analytics store runs weekly, so data can remain up to 7 days beyond the configured retention period (ADR-0015).
- **Counsel:** whether keeping `consent_records` as evidence conflicts with erasure. The current design deletes them on erasure and keeps the `dsr_requests` row as the minimal erasure record; the suppression list (hashed identifiers, 13 months) is itself retained data.

## 8. Personal data breach
- TruePath notifies affected Merchants **without undue delay and within 24 hours of confirming** a breach, with the information the Merchant needs for its own notifications: nature, extent, timing and location; affected stores and data categories; likely consequences; mitigation taken; TruePath's contact (privacy-dpdp.md §4.12).
- Under DPDP Rules 2025 Rule 7, the Merchant as Fiduciary informs affected shoppers and the Data Protection Board without delay and gives the Board a detailed report within 72 hours of becoming aware. **Counsel:** confirm this reading and the 24-hour commitment.
- No shopper data appears in the notification email; it carries an incident summary and a dashboard link.

## 9. Termination and deletion
- The Merchant can request deletion of an organisation (owner only). TruePath offers an export first, waits a **7-day grace period** in which the owner can cancel, then erases every store's personal data and revokes integration tokens. Completion is within **30 days** of the request (SPEC §5.7; auth-tenancy.md §4.6).
- Kept after deletion: the audit log for at least 1 year, and a tombstone organisation record with no personal data.
- The Merchant must uninstall the Shopify app itself. Shopify's `shop/redact` webhook then completes any remaining erasure.
- Backups made before an erasure hold the data until they age out (30 days).

## 10. Audit and assistance
- The Merchant can read its organisation's audit log in the dashboard (owners and admins). Access to personal-data views, exports, DSR actions and settings changes is logged and retained at least 1 year.
- TruePath answers reasonable written questions and, `[once per year]`, allows an audit on `[30]` days' notice, at the Merchant's cost, subject to confidentiality. **Counsel:** scope and cost.

## 11. Liability, term, governing law
`[Counsel: liability cap, indemnities, term and termination, order of precedence with the main services agreement, governing law and forum.]`

## 12. TruePath as Fiduciary for Merchant staff
TruePath processes staff name, email, credentials, sessions and audit records to provide login and security. Staff data is stored in ap-south-1; there is no third-party authentication provider (ADR-0012). Session IPs are truncated; invitations are purged 30 days after use or expiry. Staff can ask the Merchant's owner, or TruePath's grievance contact `[email]`, to correct or delete their data. **Counsel:** whether a staff-facing notice is needed at signup.

## Annex B. Security measures
- TLS 1.2 or higher in transit; HSTS on the dashboard and Collector.
- Encryption at rest for databases, disks and object storage; integration OAuth tokens envelope-encrypted with KMS; secrets in AWS Secrets Manager.
- Role-based access (owner, admin, analyst, viewer); mandatory tenant scoping in every database query, with a cross-tenant test on every route (ADR-0016).
- Pseudonymisation: no raw phone, email, IP or user agent at rest or in logs; identifiers hashed with per-tenant keys derived from a versioned master secret (ADR-0007, ADR-0020).
- Audit logging with metadata restricted to ids, enums and counts; no identifiers in audit rows.
- Rate limiting on login and sign-up; sessions expire after 14 days of inactivity.
- Daily backups with 30-day retention and a quarterly restore test.
- Log redaction with an automated PII log scan in CI.

## Annex C. Sub-processors
See `docs/dpdp/subprocessors.md` at the version accepted.

## Acceptance record
Recorded in `dpa_acceptances`: organisation, DPA version, accepting user (an owner), time, and the accepting IP truncated to /24 (IPv4) or /48 (IPv6).

## Open items for counsel (summary)
1. Company details, liability, term and governing law (section 11).
2. Sub-processor notice period and objection remedy (section 5).
3. Meta's characterisation and the Sentry EU telemetry transfer (sections 5 and 6).
4. Confirmation wording for "India requires opt-in" and responsibility if wrong (section 4).
5. s.8(7): erasure on withdrawal of analytics consent (section 7).
6. Consent evidence versus erasure, and retention of the suppression list (section 7).
7. Rule 7 breach timelines and the 24-hour processor commitment (section 8).
8. Whether data collected before default-on detection must be erased (README, "Setting India to opt-in").
