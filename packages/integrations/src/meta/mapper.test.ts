import { describe, expect, it } from 'vitest';
import { ATTRIBUTION_WINDOW, InsightsRow, mapInsightsRow } from './mapper.js';

function row(overrides: Record<string, unknown> = {}): InsightsRow {
  return InsightsRow.parse({
    date_start: '2026-09-28',
    campaign_id: '120210000000001',
    campaign_name: 'Diwali Sale',
    adset_id: '120210000000002',
    adset_name: 'Broad',
    ad_id: '120210000000003',
    ad_name: 'Creative A',
    spend: '1234.567',
    impressions: '10000',
    clicks: '150',
    actions: [
      { action_type: 'link_click', '7d_click': '100', '1d_view': '0' },
      { action_type: 'omni_purchase', '7d_click': '3', '1d_view': '1' },
    ],
    action_values: [{ action_type: 'omni_purchase', '7d_click': '1299.00', '1d_view': '499.50' }],
    ...overrides,
  });
}

describe('mapInsightsRow', () => {
  it('maps every field, rounding spend to paise', () => {
    const mapped = mapInsightsRow(row());
    expect(mapped).toMatchObject({
      date: '2026-09-28',
      campaignId: '120210000000001',
      campaignName: 'Diwali Sale',
      adsetId: '120210000000002',
      adsetName: 'Broad',
      adId: '120210000000003',
      adName: 'Creative A',
      spendPaise: 123457, // 1234.567 rounds up
      impressions: 10000,
      clicks: 150,
      attributionWindow: ATTRIBUTION_WINDOW,
    });
  });

  it('sums 7d_click + 1d_view for the purchase action and its value, in paise without float drift', () => {
    const mapped = mapInsightsRow(row());
    expect(mapped.platformConversions).toBe(4); // 3 + 1
    expect(mapped.platformConversionValuePaise).toBe(179850); // 129900 + 49950
  });

  it('prefers omni_purchase over offsite_conversion.fb_pixel_purchase when both are present', () => {
    const mapped = mapInsightsRow(
      row({
        actions: [
          { action_type: 'omni_purchase', '7d_click': '5', '1d_view': '0' },
          { action_type: 'offsite_conversion.fb_pixel_purchase', '7d_click': '99', '1d_view': '0' },
        ],
      }),
    );
    expect(mapped.platformConversions).toBe(5);
  });

  it('falls back to offsite_conversion.fb_pixel_purchase when omni_purchase is absent', () => {
    const mapped = mapInsightsRow(
      row({
        actions: [
          { action_type: 'offsite_conversion.fb_pixel_purchase', '7d_click': '7', '1d_view': '2' },
        ],
      }),
    );
    expect(mapped.platformConversions).toBe(9);
  });

  it('is zero when neither purchase action type is present, or actions/action_values are absent', () => {
    expect(
      mapInsightsRow(
        row({ actions: [{ action_type: 'link_click', '7d_click': '1' }], action_values: [] }),
      ),
    ).toMatchObject({
      platformConversions: 0,
      platformConversionValuePaise: 0,
    });
    expect(mapInsightsRow(row({ actions: undefined, action_values: undefined }))).toMatchObject({
      platformConversions: 0,
      platformConversionValuePaise: 0,
    });
  });

  it('treats a missing 7d_click or 1d_view field as 0 rather than throwing', () => {
    const mapped = mapInsightsRow(
      row({ actions: [{ action_type: 'omni_purchase', '1d_view': '2' }] }),
    );
    expect(mapped.platformConversions).toBe(2);
  });

  it('defaults missing optional string fields to empty/zero rather than throwing', () => {
    const parsed = InsightsRow.parse({ date_start: '2026-09-28' });
    const mapped = mapInsightsRow(parsed);
    expect(mapped).toMatchObject({
      campaignId: '',
      adsetId: '',
      adId: '',
      spendPaise: 0,
      impressions: 0,
      clicks: 0,
      platformConversions: 0,
      platformConversionValuePaise: 0,
    });
  });

  it('leaves accountId for the caller to fill in', () => {
    expect(mapInsightsRow(row()).accountId).toBe('');
  });
});
