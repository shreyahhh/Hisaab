CREATE TABLE IF NOT EXISTS identity_links
(
    store_id UUID,
    visitor_id String,
    identity_hash_hmac String,
    first_seen DateTime64(3, 'Asia/Kolkata'),
    last_seen DateTime64(3, 'Asia/Kolkata')
)
ENGINE = ReplacingMergeTree(last_seen)
ORDER BY (store_id, visitor_id, identity_hash_hmac)
SETTINGS min_age_to_force_merge_seconds = 604800;
