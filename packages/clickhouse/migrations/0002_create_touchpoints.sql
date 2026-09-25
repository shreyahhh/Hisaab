CREATE TABLE IF NOT EXISTS touchpoints
(
    store_id UUID,
    visitor_id String,
    session_id String,
    occurred_at DateTime64(3, 'Asia/Kolkata'),
    channel LowCardinality(String),
    sub_channel LowCardinality(String),
    platform LowCardinality(String),
    campaign_id String,
    adset_id String,
    ad_id String,
    click_id_type LowCardinality(String),
    is_direct UInt8,
    event_id UUID
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (store_id, visitor_id, occurred_at, event_id)
TTL toDateTime(occurred_at) + INTERVAL 25 MONTH
SETTINGS min_age_to_force_merge_seconds = 604800;
