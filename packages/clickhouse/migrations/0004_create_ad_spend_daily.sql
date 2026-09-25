CREATE TABLE IF NOT EXISTS ad_spend_daily
(
    store_id UUID,
    platform LowCardinality(String),
    date Date,
    account_id String,
    campaign_id String,
    campaign_name String,
    adset_id String,
    adset_name String,
    ad_id String,
    ad_name String,
    spend_paise Int64,
    impressions UInt64,
    clicks UInt64,
    platform_conversions Float64,
    platform_conversion_value_paise Int64,
    attribution_window LowCardinality(String),
    synced_at DateTime64(3)
)
ENGINE = ReplacingMergeTree(synced_at)
ORDER BY (store_id, platform, date, campaign_id, ad_id);
