CREATE TABLE IF NOT EXISTS attribution_results
(
    store_id UUID,
    order_id UUID,
    model LowCardinality(String),
    touchpoint_rank UInt16,
    channel LowCardinality(String),
    platform LowCardinality(String),
    campaign_id String,
    adset_id String,
    ad_id String,
    credit Float64,
    computed_at DateTime64(3)
)
ENGINE = MergeTree
ORDER BY (store_id, order_id, model, computed_at, touchpoint_rank)
SETTINGS min_age_to_force_merge_seconds = 604800;
