// IP → coarse location (state/city), then the IP is discarded (SPEC §5.4; collector.md §4 step 9).
//
// The planned source is the DB-IP Lite database (approved, SPEC §3), but reading its `.mmdb` needs a
// reader library that is not on the approved list, so it is not built yet (issue tracked in the PR).
// Until then the default is `nullGeo`, and `geo_state`/`geo_city` are '' — exactly what a lookup miss
// produces (collector.md §5), so nothing downstream changes when a real lookup is plugged in.

export interface GeoResult {
  readonly state: string;
  readonly city: string;
}

export interface GeoLookup {
  /** Never throws; a miss is `{state:'', city:''}`. The IP must not be retained by the implementation. */
  lookup(ip: string): GeoResult;
  /** For `/readyz`: a real implementation is ready once its database is loaded. */
  readonly ready: boolean;
  /** Names the source for a health screen; `null` when geo is off. */
  readonly source: string | null;
}

export const nullGeo: GeoLookup = {
  lookup: () => ({ state: '', city: '' }),
  ready: true,
  source: null,
};
