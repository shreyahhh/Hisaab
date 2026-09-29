import type { ClickHouseClient } from '@clickhouse/client';
import { assertStoreInScope, TenantScopeViolationError, type Scope } from '@truepath/shared';

// The only permitted API onto ClickHouse (ADR-0016, HLD §8): callers never write a query string.
// `ch(client, scope, storeId)` asserts the scope covers `storeId`, then returns a builder that
// injects a parameterised `store_id` predicate into every statement itself. Table names are
// checked against an allowlist and column identifiers are validated, but no caller-supplied value
// is ever concatenated into SQL text — every value travels as a ClickHouse query parameter.

// HLD §8 canonical ClickHouse table list.
export const CLICKHOUSE_TABLES = [
  'events',
  'touchpoints',
  'identity_links',
  'ad_spend_daily',
  'attribution_results',
  'order_status',
] as const;
export type ClickHouseTableName = (typeof CLICKHOUSE_TABLES)[number];

const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function assertSafeIdentifier(identifier: string): string {
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(`Unsafe ClickHouse identifier: ${identifier}`);
  }
  return identifier;
}

function assertKnownTable(table: string): asserts table is ClickHouseTableName {
  if (!(CLICKHOUSE_TABLES as readonly string[]).includes(table)) {
    throw new Error(`Unknown ClickHouse table: ${table}`);
  }
}

// Every insert (M1-6b) is synchronous: `wait_end_of_query` makes the call return only once the rows are
// committed and `async_insert: 0` keeps ClickHouse from buffering them server-side — `event-workers`
// XACKs a stream batch only after these calls return (event-pipeline.md §4.1 step 10), so an insert
// that "succeeded" into a buffer could lose events. (ISO-8601 timestamps with an offset go straight
// into DateTime64 columns — the builder's test inserts one — so no `date_time_input_format` is set.)
const INSERT_SETTINGS = {
  wait_end_of_query: 1,
  async_insert: 0,
} as const;

// ClickHouse parameter types we actually bind (HLD §6/§8 column types used by tenant-scoped
// queries). Extend as new query shapes need them — never accept an arbitrary type string.
export type ClickHouseParamType =
  'UUID' | 'String' | 'DateTime64(3)' | 'Int64' | 'UInt8' | 'Array(String)';

export interface WhereCondition {
  /** `IN` takes a list and must be typed `Array(String)`; every other operator takes one value. */
  readonly op: '=' | '!=' | '>' | '>=' | '<' | '<=' | 'IN';
  readonly value: unknown;
  readonly type: ClickHouseParamType;
}

/**
 * Aggregates the builder can emit, by name — a caller never supplies SQL. The `*EpochMs` forms return
 * the min/max of a DateTime64 as epoch milliseconds (an Int64, which JSON delivers as a string: parse it
 * with parseClickHouseInt64), so callers needn't interpret a time zone.
 */
export type AggregateFn = 'count' | 'uniqExact' | 'min' | 'max' | 'minEpochMs' | 'maxEpochMs';

export interface AggregateColumn {
  readonly fn: AggregateFn;
  /** Not used by `count`. */
  readonly column?: string;
  /** The result key. */
  readonly as: string;
}

export interface ScopedSelectOptions {
  readonly table: ClickHouseTableName;
  readonly columns: readonly string[];
  /** Emitted after `columns`, each as `fn(column) AS as`. Pair with `groupBy` for the plain columns. */
  readonly aggregates?: readonly AggregateColumn[];
  readonly groupBy?: readonly string[];
  /** `FROM table FINAL`: collapse ReplacingMergeTree duplicates at read time (ADR-0017). */
  readonly final?: boolean;
  readonly where?: Readonly<Record<string, WhereCondition>>;
  readonly orderBy?: string;
  /** Defaults to ascending. */
  readonly orderDirection?: 'ASC' | 'DESC';
  readonly limit?: number;
}

function aggregateSql(a: AggregateColumn): string {
  const alias = assertSafeIdentifier(a.as);
  if (a.fn === 'count') return `count() AS ${alias}`;
  if (a.column === undefined) throw new Error(`Aggregate ${a.fn} needs a column`);
  const column = assertSafeIdentifier(a.column);
  switch (a.fn) {
    case 'uniqExact':
      return `uniqExact(${column}) AS ${alias}`;
    case 'min':
      return `min(${column}) AS ${alias}`;
    case 'max':
      return `max(${column}) AS ${alias}`;
    case 'minEpochMs':
      return `toUnixTimestamp64Milli(min(${column})) AS ${alias}`;
    case 'maxEpochMs':
      return `toUnixTimestamp64Milli(max(${column})) AS ${alias}`;
  }
}

export interface ScopedClickHouse {
  select<T = Record<string, unknown>>(opts: ScopedSelectOptions): Promise<T[]>;
  insert(table: ClickHouseTableName, rows: ReadonlyArray<Record<string, unknown>>): Promise<void>;
}

/**
 * The one entry point for querying ClickHouse (ADR-0016). Throws {@link TenantScopeViolationError}
 * immediately if `scope` doesn't cover `storeId` — nothing built from the returned object can ever
 * touch another tenant's rows.
 */
export function ch(client: ClickHouseClient, scope: Scope, storeId: string): ScopedClickHouse {
  assertStoreInScope(scope, storeId);

  return {
    async insert(table, rows) {
      assertKnownTable(table);
      for (const row of rows) {
        if (row['store_id'] !== storeId) {
          throw new TenantScopeViolationError('store', String(row['store_id']));
        }
      }
      if (rows.length === 0) return;
      await client.insert({
        table,
        values: [...rows],
        format: 'JSONEachRow',
        clickhouse_settings: INSERT_SETTINGS,
      });
    },

    async select<T = Record<string, unknown>>(opts: ScopedSelectOptions): Promise<T[]> {
      assertKnownTable(opts.table);
      const selectList = [
        ...opts.columns.map(assertSafeIdentifier),
        ...(opts.aggregates ?? []).map(aggregateSql),
      ];
      if (selectList.length === 0) throw new Error('select() needs at least one column');
      const columns = selectList.join(', ');

      const whereClauses = ['store_id = {store_id:UUID}'];
      const params: Record<string, unknown> = { store_id: storeId };

      for (const [column, condition] of Object.entries(opts.where ?? {})) {
        assertSafeIdentifier(column);
        if ((condition.op === 'IN') !== (condition.type === 'Array(String)')) {
          throw new Error('IN takes an Array(String) and Array(String) is only for IN');
        }
        const paramName = `w_${column}`;
        whereClauses.push(`${column} ${condition.op} {${paramName}:${condition.type}}`);
        params[paramName] = condition.value;
      }

      const groupBy = opts.groupBy?.length
        ? ` GROUP BY ${opts.groupBy.map(assertSafeIdentifier).join(', ')}`
        : '';
      const orderBy = opts.orderBy
        ? ` ORDER BY ${assertSafeIdentifier(opts.orderBy)}${opts.orderDirection === 'DESC' ? ' DESC' : ''}`
        : '';
      const limit = opts.limit !== undefined ? ` LIMIT ${Math.trunc(opts.limit)}` : '';
      const query = `SELECT ${columns} FROM ${opts.table}${opts.final ? ' FINAL' : ''} WHERE ${whereClauses.join(' AND ')}${groupBy}${orderBy}${limit}`;

      const result = await client.query({ query, query_params: params, format: 'JSONEachRow' });
      return result.json<T>();
    },
  };
}
