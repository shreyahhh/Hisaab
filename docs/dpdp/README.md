# DPDP documents

This folder holds the privacy documents listed in SPEC §4 and §5. The DPA template and shopper notice are **engineering drafts for counsel** (SPEC M0-7), not approved legal text. The RoPA and breach runbook are not drafted yet.

## Engineering facts the shopper notice must reflect

- **Erasure is permanent for 13 months, across devices.** After a shopper's data is erased, TruePath does not track them for that store for the suppression period (13 months). This applies on a new device or browser too: once the shopper enters the same phone number or email at checkout, their activity is dropped, and any earlier activity from that new device is deleted. Before that point we cannot recognise them on a new device, so a few page views may be collected briefly and then deleted. Design: [HLD §8 Suppression set](../architecture/HLD.md#suppression-set-erasure-and-consent-withdrawal).
- **Withdrawing consent deletes the data collected so far.** When a shopper withdraws analytics consent, TruePath stops tracking that browser and deletes the activity already collected from it, normally within 24 hours. Withdrawing only marketing consent stops sharing with ad platforms (Meta) but keeps analytics. Events already sent to Meta before the withdrawal cannot be recalled. Order records the merchant receives from Shopify are kept, but they are no longer linked to that browser's activity. *Counsel review pending (DPDP Act s.8(7)).* Design: [privacy-dpdp.md §4.5](../architecture/lld/privacy-dpdp.md#45-withdrawal-triggered-erasure-dpdp-s87).
- **Withdrawal can be reversed.** A shopper who withdraws consent can grant it again later, and tracking resumes (starting fresh, since earlier data was deleted). A shopper whose data was erased cannot be re-tracked this way during the suppression period.
- **After a withdrawal, the merchant's order records are kept.** The phone/email fingerprints (HMACs) on orders come from the merchant's own Shopify order data, not from the tracking pixel. So they are kept when pixel consent is withdrawn, while the browser activity is deleted. A full erasure request removes them too. *Counsel review pending.*
- **How fast deletion happens.** Deleted analytics rows are hidden from every report and export immediately and physically removed from disk within 7 days. Database backups still hold them for up to 30 days after that. Routine retention clean-up of analytics data runs weekly, so data can remain up to 7 days past the configured retention period. Design: [ADR-0015](../adr/0015-clickhouse-deletion-strategy.md).
- **Shopper IP addresses are not kept, including in infrastructure logs.** The Collector uses the IP only to look up state and city, then discards it. The load balancer in front of the Collector has access logging switched off. If logging is ever enabled temporarily for an investigation, those logs are deleted after 7 days. Design: [privacy-dpdp.md §4.11](../architecture/lld/privacy-dpdp.md#411-infrastructure-logs).
- **IP geolocation attribution.** State/city lookup uses DB-IP Lite, licensed CC BY 4.0. Required attribution: "IP geolocation by [DB-IP](https://db-ip.com)", shown in the dashboard footer and here.

## Setting India to opt-in (required before tracking starts)
In regions where Shopify treats tracking as enabled by default, app pixels run "as events are registered until the user opts out" ([Shopify pixels](https://shopify.dev/docs/apps/build/marketing/pixels)). India is likely default-on unless the merchant configures opt-in. **TruePath keeps tracking disabled until the merchant confirms India requires opt-in** (SPEC v0.6 P-1; design in [privacy-dpdp.md §4.13](../architecture/lld/privacy-dpdp.md#413-consent-region-gate--default-on-regions-spec-v06)).

Merchant guide (the same steps appear in onboarding step 8):
1. In Shopify admin, go to **Settings → Customer privacy → Cookie banner → Regions and content**. Click **Edit** in the *Regions* section and select the region that covers India, so the banner shows there and consent is required before tracking ([Shopify help](https://help.shopify.com/en/manual/privacy-and-security/privacy/customer-privacy-settings/privacy-settings)).
2. Shopify's documentation describes region-level selection and automatic set-up for the UK/EEA, but not a per-country India setting. **If India can't be selected**, install a consent-management app that integrates with Shopify's Customer Privacy API and configure India as opt-in there.
3. Verify from India: open the store in a fresh incognito window. With TruePath's "tracking live" check open, confirm that **no events arrive until you accept analytics cookies**.
4. In TruePath onboarding, tick **"India requires opt-in in my consent banner"**. This is recorded with your user and time in the audit log.

After go-live, TruePath watches for new visitors who were tracked without any banner interaction. If that becomes common, it warns you, and if it persists it **pauses tracking automatically** until you fix the banner and re-confirm. *Counsel review pending:* the confirmation wording, and whether data collected before a pause must be erased.

The exact admin labels in steps 1–2 are confirmed in the dev-store test (collector.md Q3c) and updated here.

## Files in this folder
- [subprocessors.md](subprocessors.md) — sub-processor list (S-7).
- [dpa-template.md](dpa-template.md) — DPA draft, version `0.1-draft`, with an open-items list for counsel.
- [shopper-notice.md](shopper-notice.md) — shopper notice draft, English + Hindi (SPEC P-2).
- [../m0-7-external-setup.md](../m0-7-external-setup.md) — the human-only steps of M0-7 (app registrations, access requests, counsel review).
- To be drafted with counsel: RoPA, `breach-runbook.md`.
