import { STREAM_FIELD_PAYLOAD, STREAM_FIELD_STORE_ID, StreamEntry } from '@truepath/shared';

// Reading `stream:events-raw` entries (collector.md §2.4): every entry has exactly two fields,
// `store_id` and `payload` (the JSON of a `StreamEntry`). An entry that doesn't validate is not
// acknowledged: it stays pending and the reclaimer dead-letters it after 5 deliveries
// (event-pipeline.md §4.5), which tolerates a collector/worker version skew during a deploy.

export interface RawStreamEntry {
  readonly id: string;
  readonly fields: Readonly<Record<string, string>>;
}

/** ioredis returns `[id, [k1, v1, k2, v2, …]]` per entry. */
export function toRawEntry(id: string, flat: readonly string[]): RawStreamEntry {
  const fields: Record<string, string> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) fields[flat[i]!] = flat[i + 1]!;
  return { id, fields };
}

export interface ParsedEntry {
  readonly id: string;
  readonly entry: StreamEntry;
}

/** Null when the entry doesn't validate, or when its `store_id` field disagrees with its payload. */
export function parseStreamEntry(raw: RawStreamEntry): ParsedEntry | null {
  const payload = raw.fields[STREAM_FIELD_PAYLOAD];
  if (payload === undefined) return null;
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return null;
  }
  const parsed = StreamEntry.safeParse(json);
  if (!parsed.success) return null;
  if (raw.fields[STREAM_FIELD_STORE_ID] !== parsed.data.store_id) return null;
  return { id: raw.id, entry: parsed.data };
}
