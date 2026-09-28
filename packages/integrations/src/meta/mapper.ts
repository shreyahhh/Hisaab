import { z } from 'zod';
import { roundDecimalToPaise } from '../money.js';
import type { MetaSpendRow } from './types.js';

// Pure mapping (meta-integration.md §4.2) — no I/O — so it gets the same fast, exhaustive unit-test
// treatment as the Shopify mapper.

/** LLD §2.3: `action_attribution_windows=["7d_click","1d_view"]`; the row's own value carries this too. */
export const ATTRIBUTION_WINDOW = '7d_click+1d_view';

// The action_type Ads Manager's "Purchases" column corresponds to for a Shopify-channel pixel is marked
// **VERIFY** in the LLD; these are its stated candidates, tried in order — omni_purchase first.
export const PURCHASE_ACTION_TYPES = [
  'omni_purchase',
  'offsite_conversion.fb_pixel_purchase',
] as const;

const ActionValue = z.object({
  action_type: z.string(),
  value: z.string().optional(),
  '7d_click': z.string().optional(),
  '1d_view': z.string().optional(),
});

export const InsightsRow = z.object({
  date_start: z.string(),
  campaign_id: z.string().default(''),
  campaign_name: z.string().default(''),
  adset_id: z.string().default(''),
  adset_name: z.string().default(''),
  ad_id: z.string().default(''),
  ad_name: z.string().default(''),
  spend: z.string().default('0'),
  impressions: z.string().default('0'),
  clicks: z.string().default('0'),
  actions: z.array(ActionValue).optional(),
  action_values: z.array(ActionValue).optional(),
});
export type InsightsRow = z.infer<typeof InsightsRow>;

/** Sums an action's `7d_click` + `1d_view` fields (click-through and view-through are separate windows). */
function clickPlusView(entry: z.infer<typeof ActionValue> | undefined): number {
  if (!entry) return 0;
  const click = Number(entry['7d_click'] ?? '0');
  const view = Number(entry['1d_view'] ?? '0');
  return (Number.isFinite(click) ? click : 0) + (Number.isFinite(view) ? view : 0);
}

/** Same sum as `clickPlusView`, but for a money field: each side rounds to paise before adding, so the
 * total never passes through float arithmetic on rupee amounts (SPEC "Money in paise"). */
function clickPlusViewPaise(entry: z.infer<typeof ActionValue> | undefined): number {
  if (!entry) return 0;
  const click = entry['7d_click'] !== undefined ? roundDecimalToPaise(entry['7d_click']) : 0;
  const view = entry['1d_view'] !== undefined ? roundDecimalToPaise(entry['1d_view']) : 0;
  return click + view;
}

function findPurchaseAction(
  actions: readonly z.infer<typeof ActionValue>[] | undefined,
): z.infer<typeof ActionValue> | undefined {
  if (!actions) return undefined;
  for (const type of PURCHASE_ACTION_TYPES) {
    const found = actions.find((a) => a.action_type === type);
    if (found) return found;
  }
  return undefined;
}

const toInt = (value: string): number => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/**
 * One Insights API row (meta-integration.md §4.2 steps 3–4). `platform_conversions`/`_value` come from
 * whichever purchase action type is present first, `7d_click + 1d_view` summed; `spend_paise` is
 * rounded, not truncated (SPEC "Money in paise").
 */
export function mapInsightsRow(row: InsightsRow): MetaSpendRow {
  const purchaseActions = findPurchaseAction(row.actions);
  const purchaseValues = findPurchaseAction(row.action_values);
  return {
    date: row.date_start,
    accountId: '', // filled in by the caller, who knows which account this pull was for
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    adsetId: row.adset_id,
    adsetName: row.adset_name,
    adId: row.ad_id,
    adName: row.ad_name,
    spendPaise: roundDecimalToPaise(row.spend),
    impressions: toInt(row.impressions),
    clicks: toInt(row.clicks),
    platformConversions: clickPlusView(purchaseActions),
    platformConversionValuePaise: clickPlusViewPaise(purchaseValues),
    attributionWindow: ATTRIBUTION_WINDOW,
  };
}
