CREATE TABLE IF NOT EXISTS events
(
    store_id UUID,
    event_id UUID,
    event_name LowCardinality(String),
    occurred_at DateTime64(3, 'Asia/Kolkata'),
    received_at DateTime64(3),
    visitor_id String,
    session_id String,
    page_url String,
    referrer String,
    utm_source String,
    utm_medium String,
    utm_campaign String,
    utm_content String,
    utm_term String,
    fbclid String,
    gclid String,
    gbraid String,
    wbraid String,
    fbp String,
    fbc String,
    device_type LowCardinality(String),
    os LowCardinality(String),
    browser LowCardinality(String),
    is_in_app_browser UInt8,
    geo_state LowCardinality(String),
    geo_city LowCardinality(String),
    consent_purposes Array(String),
    identity_hash_hmac String,
    properties String
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (store_id, visitor_id, occurred_at, event_id)
TTL toDateTime(occurred_at) + INTERVAL 25 MONTH
SETTINGS min_age_to_force_merge_seconds = 604800;
