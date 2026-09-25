CREATE TABLE IF NOT EXISTS order_status
(
    store_id UUID,
    order_id UUID,
    delivery_status LowCardinality(String),
    total_amount_paise Int64,
    refunded_amount_paise Int64,
    delivered_at Nullable(DateTime64(3, 'Asia/Kolkata')),
    rto_at Nullable(DateTime64(3, 'Asia/Kolkata')),
    placed_at DateTime64(3, 'Asia/Kolkata'),
    payment_method LowCardinality(String),
    is_first_order UInt8,
    pincode_prefix LowCardinality(String),
    source_updated_at DateTime64(3)
)
ENGINE = ReplacingMergeTree(source_updated_at)
ORDER BY (store_id, order_id)
SETTINGS min_age_to_force_merge_seconds = 604800;
