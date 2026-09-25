import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, '../migrations');

function read(file: string): string {
  return readFileSync(path.join(migrationsDir, file), 'utf8');
}

// No live ClickHouse in this sandbox (no Docker) — these are DDL-shape checks against the
// canonical engine/ORDER BY/TTL spec in HLD §8, not a substitute for actually applying the
// migrations against a real server.
describe('ClickHouse migrations (SPEC §6.2, HLD §8)', () => {
  it('events: ReplacingMergeTree keyed on (store_id, visitor_id, occurred_at, event_id) (ADR-0017)', () => {
    const sql = read('0001_create_events.sql');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS events');
    expect(sql).toContain('ENGINE = ReplacingMergeTree');
    expect(sql).toContain('ORDER BY (store_id, visitor_id, occurred_at, event_id)');
    // TTL on a DateTime64 column must be cast to DateTime/Date first — ClickHouse rejects a bare
    // DateTime64 TTL expression with BAD_TTL_EXPRESSION (hit against a live 24.8 server).
    expect(sql).toContain('TTL toDateTime(occurred_at) + INTERVAL 25 MONTH');
  });

  it('touchpoints: same key shape as events (ADR-0017)', () => {
    const sql = read('0002_create_touchpoints.sql');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS touchpoints');
    expect(sql).toContain('ORDER BY (store_id, visitor_id, occurred_at, event_id)');
    expect(sql).toContain('TTL toDateTime(occurred_at) + INTERVAL 25 MONTH');
  });

  it('identity_links: ReplacingMergeTree(last_seen)', () => {
    const sql = read('0003_create_identity_links.sql');
    expect(sql).toContain('ENGINE = ReplacingMergeTree(last_seen)');
    expect(sql).toContain('ORDER BY (store_id, visitor_id, identity_hash_hmac)');
  });

  it('ad_spend_daily: ReplacingMergeTree(synced_at), campaign_id in the sort key', () => {
    const sql = read('0004_create_ad_spend_daily.sql');
    expect(sql).toContain('ENGINE = ReplacingMergeTree(synced_at)');
    expect(sql).toContain('ORDER BY (store_id, platform, date, campaign_id, ad_id)');
  });

  it('attribution_results: MergeTree versioned by computed_at (run version)', () => {
    const sql = read('0005_create_attribution_results.sql');
    expect(sql).toContain('ENGINE = MergeTree');
    expect(sql).toContain('ORDER BY (store_id, order_id, model, computed_at, touchpoint_rank)');
  });

  it('order_status: ReplacingMergeTree(source_updated_at)', () => {
    const sql = read('0006_create_order_status.sql');
    expect(sql).toContain('ENGINE = ReplacingMergeTree(source_updated_at)');
    expect(sql).toContain('ORDER BY (store_id, order_id)');
  });

  it('every deletable table sets min_age_to_force_merge_seconds = 604800 (ADR-0015, 7-day physical purge)', () => {
    for (const file of [
      '0001_create_events.sql',
      '0002_create_touchpoints.sql',
      '0003_create_identity_links.sql',
      '0005_create_attribution_results.sql',
      '0006_create_order_status.sql',
    ]) {
      expect(read(file)).toContain('min_age_to_force_merge_seconds = 604800');
    }
  });
});
