import { describe, expect, it } from 'vitest';
import {
  campaignFingerprint,
  classify,
  clickIdType,
  externalReferrerHost,
  isIgnorableReferrerHost,
  normaliseHost,
  parseChannelRules,
  parseLanding,
  resolveFbc,
  ruleMatches,
  type ChannelRule,
  type Classification,
  type Landing,
} from './events.js';
import { CHANNEL_SLUGS } from './valueLists.js';

const SHOP_HOSTS = ['shop.example.com', 'example.myshopify.com'];
const ctx = { shopHosts: SHOP_HOSTS };

const EMPTY: Landing = {
  utm_source: '',
  utm_medium: '',
  utm_campaign: '',
  utm_content: '',
  utm_term: '',
  fbclid: '',
  gclid: '',
  gbraid: '',
  wbraid: '',
  referrer_host: '',
};
const L = (overrides: Partial<Landing> = {}): Landing => ({ ...EMPTY, ...overrides });

describe('parseLanding', () => {
  it('lowercases and trims UTMs but keeps click ids as sent', () => {
    const l = parseLanding(
      'https://shop.example.com/p?utm_source=Instagram%20&utm_medium=CPC&fbclid=AbC123&gclid=XyZ',
      'https://WWW.Google.com/search?q=x',
    );
    expect(l).toMatchObject({
      utm_source: 'instagram',
      utm_medium: 'cpc',
      fbclid: 'AbC123',
      gclid: 'XyZ',
      referrer_host: 'google.com',
    });
  });

  it('returns an all-empty landing for unparsable input', () => {
    expect(parseLanding('not a url', '')).toEqual(EMPTY);
    expect(parseLanding('', 'also not a url')).toEqual(EMPTY);
  });

  it('parses a non-http referrer such as an Android app', () => {
    expect(
      parseLanding('https://shop.example.com/', 'android-app://com.instagram.android')
        .referrer_host,
    ).toBe('com.instagram.android');
  });
});

describe('resolveFbc', () => {
  const landing = L({ fbclid: 'IwAR0abc' });
  it('keeps an fbc the pixel sent', () => {
    expect(resolveFbc('fb.1.1700000000000.OLD', landing, 1_700_000_999_000)).toBe(
      'fb.1.1700000000000.OLD',
    );
  });
  it("builds Meta's server-side format from fbclid and the landing time", () => {
    expect(resolveFbc(undefined, landing, 1_790_000_000_123.9)).toBe('fb.1.1790000000123.IwAR0abc');
    expect(resolveFbc('', landing, 1_790_000_000_000)).toBe('fb.1.1790000000000.IwAR0abc');
  });
  it('is empty without an fbclid', () => {
    expect(resolveFbc(undefined, L(), 1_790_000_000_000)).toBe('');
  });
});

describe('referrers', () => {
  it('treats shop hosts, checkout and payment gateways as ignorable (www stripped, case-insensitive)', () => {
    for (const host of [
      '',
      'shop.example.com',
      'WWW.Shop.Example.com',
      'example.myshopify.com',
      'checkout.shopify.com',
      'shop.app',
      'api.razorpay.com',
      'secure.payu.in',
      'securegw.paytm.in',
      'gokwik.co',
    ]) {
      expect(isIgnorableReferrerHost(host, SHOP_HOSTS), host).toBe(true);
    }
  });
  it('does not treat other hosts as ignorable', () => {
    expect(isIgnorableReferrerHost('google.com', SHOP_HOSTS)).toBe(false);
    expect(isIgnorableReferrerHost('evil-razorpay.com', SHOP_HOSTS)).toBe(false);
  });
  it('externalReferrerHost returns the normalised host or empty', () => {
    expect(externalReferrerHost(L({ referrer_host: 'www.blog.example.org' }), SHOP_HOSTS)).toBe(
      'blog.example.org',
    );
    expect(externalReferrerHost(L({ referrer_host: 'razorpay.com' }), SHOP_HOSTS)).toBe('');
  });
  it('normaliseHost', () => {
    expect(normaliseHost(' WWW.Example.COM ')).toBe('example.com');
    expect(normaliseHost('wwwx.example.com')).toBe('wwwx.example.com');
  });
});

describe('campaignFingerprint / clickIdType', () => {
  it("is '' when no campaign parameter is present", () => {
    expect(campaignFingerprint(L({ referrer_host: 'google.com' }))).toBe('');
  });
  it('joins the parameters and the click id value in a fixed order', () => {
    expect(
      campaignFingerprint(L({ utm_source: 'facebook', utm_campaign: '123', fbclid: 'AbC' })),
    ).toBe('facebook||123|||AbC');
  });
  it('differs when only the click id changes', () => {
    expect(campaignFingerprint(L({ gclid: 'a' }))).not.toBe(campaignFingerprint(L({ gclid: 'b' })));
  });
  it('clickIdType follows the order fbclid, gclid, gbraid, wbraid', () => {
    expect(clickIdType(L())).toBe('');
    expect(clickIdType(L({ wbraid: 'w' }))).toBe('wbraid');
    expect(clickIdType(L({ wbraid: 'w', gbraid: 'g' }))).toBe('gbraid');
    expect(clickIdType(L({ wbraid: 'w', gclid: 'c', fbclid: 'f' }))).toBe('fbclid');
  });
});

type Row = [name: string, landing: Landing, expected: Partial<Classification>];

const DEFAULT_ROWS: Row[] = [
  // 1
  [
    'fbclid alone',
    L({ fbclid: 'x' }),
    { channel: 'meta_ads', sub_channel: 'facebook', platform: 'meta', click_id_type: 'fbclid' },
  ],
  [
    'facebook + paid_social',
    L({ utm_source: 'facebook', utm_medium: 'paid_social' }),
    { channel: 'meta_ads', sub_channel: 'facebook', click_id_type: '' },
  ],
  [
    'instagram + cpc',
    L({ utm_source: 'instagram', utm_medium: 'cpc' }),
    { channel: 'meta_ads', sub_channel: 'instagram' },
  ],
  [
    'meta + paid',
    L({ utm_source: 'meta', utm_medium: 'paid' }),
    { channel: 'meta_ads', sub_channel: 'meta' },
  ],
  // 2
  [
    'ig + social medium',
    L({ utm_source: 'ig', utm_medium: 'social' }),
    { channel: 'organic_social', sub_channel: 'ig', platform: null },
  ],
  [
    'facebook, no medium',
    L({ utm_source: 'facebook' }),
    { channel: 'organic_social', sub_channel: 'facebook' },
  ],
  // 3
  [
    'gclid',
    L({ gclid: 'g' }),
    { channel: 'google_ads', sub_channel: 'cpc', platform: 'google', click_id_type: 'gclid' },
  ],
  ['gbraid', L({ gbraid: 'g' }), { channel: 'google_ads', click_id_type: 'gbraid' }],
  ['wbraid', L({ wbraid: 'g' }), { channel: 'google_ads', click_id_type: 'wbraid' }],
  ['gclid + gbraid prefers gclid', L({ gclid: 'a', gbraid: 'b' }), { click_id_type: 'gclid' }],
  [
    'google / cpc',
    L({ utm_source: 'google', utm_medium: 'cpc' }),
    { channel: 'google_ads', sub_channel: 'cpc', click_id_type: '' },
  ],
  // 4-6
  [
    'email medium',
    L({ utm_source: 'klaviyo', utm_medium: 'email' }),
    { channel: 'email', sub_channel: 'klaviyo', platform: null },
  ],
  [
    'whatsapp source',
    L({ utm_source: 'whatsapp', utm_medium: 'share' }),
    { channel: 'whatsapp', sub_channel: 'share' },
  ],
  ['wa source', L({ utm_source: 'wa' }), { channel: 'whatsapp', sub_channel: '' }],
  [
    'influencer medium',
    L({ utm_source: 'creator1', utm_medium: 'influencer' }),
    { channel: 'influencer_affiliate', sub_channel: 'creator1' },
  ],
  [
    'affiliate medium',
    L({ utm_source: 'network', utm_medium: 'affiliate' }),
    { channel: 'influencer_affiliate', sub_channel: 'network' },
  ],
  // 7
  [
    'unmatched UTMs',
    L({ utm_source: 'newsletter', utm_medium: 'social' }),
    { channel: 'other_campaign', sub_channel: 'newsletter' },
  ],
  [
    'a lone utm_campaign',
    L({ utm_campaign: 'diwali' }),
    { channel: 'other_campaign', sub_channel: '' },
  ],
  [
    'google source but organic medium',
    L({ utm_source: 'google', utm_medium: 'organic' }),
    { channel: 'other_campaign' },
  ],
  // 8
  [
    'google referrer',
    L({ referrer_host: 'google.com' }),
    { channel: 'organic_search', sub_channel: 'google.com' },
  ],
  [
    'google.co.in referrer',
    L({ referrer_host: 'google.co.in' }),
    { channel: 'organic_search', sub_channel: 'google.co.in' },
  ],
  [
    'bing referrer',
    L({ referrer_host: 'bing.com' }),
    { channel: 'organic_search', sub_channel: 'bing.com' },
  ],
  // 9
  [
    'l.instagram.com referrer',
    L({ referrer_host: 'l.instagram.com' }),
    { channel: 'organic_social', sub_channel: 'l.instagram.com' },
  ],
  [
    'm.facebook.com referrer',
    L({ referrer_host: 'm.facebook.com' }),
    { channel: 'organic_social' },
  ],
  // 10
  [
    'other referrer',
    L({ referrer_host: 'blog.example.org' }),
    { channel: 'referral', sub_channel: 'blog.example.org', is_direct: 0 },
  ],
  [
    'a google lookalike is a referral',
    L({ referrer_host: 'notgoogle.com' }),
    { channel: 'referral' },
  ],
  // 11
  [
    'nothing at all',
    L(),
    { channel: 'direct', sub_channel: '', platform: null, is_direct: 1, click_id_type: '' },
  ],
  // ignorable referrers behave as no referrer
  [
    'own shop referrer',
    L({ referrer_host: 'shop.example.com' }),
    { channel: 'direct', is_direct: 1 },
  ],
  ['razorpay return', L({ referrer_host: 'razorpay.com' }), { channel: 'direct', is_direct: 1 }],
  [
    'checkout.shopify.com return',
    L({ referrer_host: 'checkout.shopify.com' }),
    { channel: 'direct' },
  ],
  // precedence
  [
    'fbclid beats utm_medium=email',
    L({ fbclid: 'x', utm_medium: 'email' }),
    { channel: 'meta_ads', click_id_type: 'fbclid' },
  ],
  [
    'fbclid beats gclid',
    L({ fbclid: 'x', gclid: 'y' }),
    { channel: 'meta_ads', click_id_type: 'fbclid' },
  ],
  [
    'explicit UTM beats referrer inference',
    L({ utm_source: 'newsletter', referrer_host: 'google.com' }),
    { channel: 'other_campaign' },
  ],
  [
    'click id beats google referrer',
    L({ gclid: 'g', referrer_host: 'google.com' }),
    { channel: 'google_ads' },
  ],
];

describe('classify — SPEC §7.4 defaults', () => {
  it.each(DEFAULT_ROWS)('%s', (_name, landing, expected) => {
    expect(classify(landing, [], ctx)).toMatchObject(expected);
  });

  it('normalises case and whitespace when the landing comes from a URL', () => {
    const landing = parseLanding(
      'https://shop.example.com/?utm_source=Instagram%20&utm_medium=%20CPC',
      '',
    );
    expect(classify(landing, [], ctx)).toMatchObject({
      channel: 'meta_ads',
      sub_channel: 'instagram',
    });
  });
});

describe('classify — campaign mapping', () => {
  const meta = { utm_source: 'facebook', utm_medium: 'paid_social' };

  it('maps numeric utm_campaign / utm_content / utm_term to campaign / ad set / ad for Meta', () => {
    expect(
      classify(
        L({ ...meta, utm_campaign: '120210', utm_content: '120211', utm_term: '120212' }),
        [],
        ctx,
      ),
    ).toMatchObject({ campaign_id: '120210', adset_id: '120211', ad_id: '120212' });
  });

  it('maps the same way for Google (ValueTrack ids)', () => {
    expect(
      classify(
        L({
          utm_source: 'google',
          utm_medium: 'cpc',
          utm_campaign: '99',
          utm_content: '77',
          utm_term: '55',
          gclid: 'g',
        }),
        [],
        ctx,
      ),
    ).toMatchObject({ platform: 'google', campaign_id: '99', adset_id: '77', ad_id: '55' });
  });

  it('leaves an id empty when the value is a name, not a number', () => {
    expect(
      classify(
        L({ ...meta, utm_campaign: 'diwali_sale', utm_content: '5', utm_term: 'a1' }),
        [],
        ctx,
      ),
    ).toMatchObject({ campaign_id: '', adset_id: '5', ad_id: '' });
  });

  it('accepts up to 24 digits and rejects 25', () => {
    expect(classify(L({ ...meta, utm_campaign: '1'.repeat(24) }), [], ctx).campaign_id).toBe(
      '1'.repeat(24),
    );
    expect(classify(L({ ...meta, utm_campaign: '1'.repeat(25) }), [], ctx).campaign_id).toBe('');
  });

  it('maps Performance Max (gclid, no utm_content) at campaign level only', () => {
    expect(classify(L({ gclid: 'g', utm_campaign: '4242' }), [], ctx)).toMatchObject({
      channel: 'google_ads',
      campaign_id: '4242',
      adset_id: '',
      ad_id: '',
    });
  });

  it('maps ids only for platform channels', () => {
    expect(
      classify(L({ utm_source: 'klaviyo', utm_medium: 'email', utm_campaign: '123' }), [], ctx),
    ).toMatchObject({ channel: 'email', campaign_id: '' });
  });
});

describe('classify — merchant channel_rules', () => {
  const rule = (overrides: Partial<ChannelRule> & Pick<ChannelRule, 'match'>): ChannelRule => ({
    id: 'r1',
    priority: 10,
    channel: 'influencer_affiliate',
    sub_channel: 'custom',
    ...overrides,
  });

  it('a matching rule overrides the defaults', () => {
    const rules = [
      rule({ match: { all: [{ field: 'utm_campaign', op: 'contains', value: 'creator' }] } }),
    ];
    expect(classify(L({ fbclid: 'x', utm_campaign: 'creator_march' }), rules, ctx)).toMatchObject({
      channel: 'influencer_affiliate',
      sub_channel: 'custom',
      platform: null,
      campaign_id: '',
      click_id_type: '',
    });
  });

  it('falls back to the defaults when no rule matches', () => {
    const rules = [
      rule({ match: { all: [{ field: 'utm_source', op: 'eq', value: 'sharechat' }] } }),
    ];
    expect(classify(L({ fbclid: 'x' }), rules, ctx).channel).toBe('meta_ads');
  });

  it('a rule that assigns a platform channel gets id mapping and its click id', () => {
    const rules = [
      rule({
        channel: 'meta_ads',
        sub_channel: 'threads',
        match: { all: [{ field: 'utm_source', op: 'eq', value: 'threads' }] },
      }),
    ];
    expect(
      classify(L({ utm_source: 'threads', utm_campaign: '7', fbclid: 'f' }), rules, ctx),
    ).toMatchObject({
      channel: 'meta_ads',
      sub_channel: 'threads',
      platform: 'meta',
      campaign_id: '7',
      click_id_type: 'fbclid',
    });
  });

  it('picks the lowest priority number, and the lowest id on a tie', () => {
    const any = { all: [{ field: 'utm_source' as const, op: 'present' as const }] };
    const rules = [
      rule({ id: 'b', priority: 5, channel: 'email', match: any }),
      rule({ id: 'a', priority: 5, channel: 'whatsapp', match: any }),
      rule({ id: 'c', priority: 9, channel: 'referral', match: any }),
    ];
    expect(classify(L({ utm_source: 'x' }), rules, ctx).channel).toBe('whatsapp');
    expect(classify(L({ utm_source: 'x' }), [...rules].reverse(), ctx).channel).toBe('whatsapp');
  });

  it("rules see the effective referrer: the shop's own host is 'no referrer'", () => {
    const rules = [
      rule({ match: { all: [{ field: 'referrer_host', op: 'absent' }] }, channel: 'email' }),
    ];
    expect(classify(L({ referrer_host: 'shop.example.com' }), rules, ctx).channel).toBe('email');
    expect(classify(L({ referrer_host: 'google.com' }), rules, ctx).channel).toBe('organic_search');
  });
});

describe('ruleMatches', () => {
  const l = L({
    utm_source: 'Newsletter',
    utm_medium: 'email',
    referrer_host: 'blog.example.org',
    gclid: 'g',
  });

  it.each([
    [
      'eq is case-insensitive and trimmed',
      { all: [{ field: 'utm_source', op: 'eq', value: ' NEWSLETTER ' }] },
      true,
    ],
    ['eq mismatch', { all: [{ field: 'utm_source', op: 'eq', value: 'news' }] }, false],
    ['in (array)', { all: [{ field: 'utm_medium', op: 'in', value: ['sms', 'EMAIL'] }] }, true],
    ['in (single string)', { all: [{ field: 'utm_medium', op: 'in', value: 'email' }] }, true],
    ['contains', { all: [{ field: 'referrer_host', op: 'contains', value: 'example' }] }, true],
    ['starts_with', { all: [{ field: 'referrer_host', op: 'starts_with', value: 'blog.' }] }, true],
    [
      'starts_with mismatch',
      { all: [{ field: 'referrer_host', op: 'starts_with', value: 'example' }] },
      false,
    ],
    ['present', { all: [{ field: 'utm_medium', op: 'present' }] }, true],
    ['present on empty', { all: [{ field: 'utm_term', op: 'present' }] }, false],
    ['absent', { all: [{ field: 'utm_term', op: 'absent' }] }, true],
    ['click_id_type', { all: [{ field: 'click_id_type', op: 'eq', value: 'gclid' }] }, true],
    [
      'all requires every condition',
      {
        all: [
          { field: 'utm_medium', op: 'eq', value: 'email' },
          { field: 'utm_term', op: 'present' },
        ],
      },
      false,
    ],
    [
      'any requires one',
      {
        any: [
          { field: 'utm_term', op: 'present' },
          { field: 'utm_medium', op: 'eq', value: 'email' },
        ],
      },
      true,
    ],
    ['any with none matching', { any: [{ field: 'utm_term', op: 'present' }] }, false],
    [
      'all and any must both hold',
      {
        all: [{ field: 'utm_medium', op: 'eq', value: 'email' }],
        any: [{ field: 'utm_term', op: 'present' }],
      },
      false,
    ],
    [
      'a value-taking op without a value never matches',
      { all: [{ field: 'utm_medium', op: 'eq' }] },
      false,
    ],
    [
      'eq with an array never matches',
      { all: [{ field: 'utm_medium', op: 'eq', value: ['email'] }] },
      false,
    ],
    [
      'an empty needle never matches',
      { all: [{ field: 'utm_medium', op: 'contains', value: '' }] },
      false,
    ],
  ] as const)('%s', (_name, match, expected) => {
    expect(ruleMatches(match as never, l)).toBe(expected);
  });
});

describe('parseChannelRules', () => {
  const valid = {
    id: 'ok',
    priority: 1,
    match: { all: [{ field: 'utm_source', op: 'present' }] },
    channel: 'email',
    subChannel: null,
  };

  it('keeps valid rows, defaulting a null sub_channel to empty', () => {
    expect(parseChannelRules([valid])).toEqual({
      rules: [{ id: 'ok', priority: 1, match: valid.match, channel: 'email', sub_channel: '' }],
      ignored: [],
    });
  });

  it('skips and reports invalid rows', () => {
    const rows = [
      valid,
      { ...valid, id: 'empty', match: {} },
      {
        ...valid,
        id: 'bad-op',
        match: { all: [{ field: 'utm_source', op: 'regex', value: 'x' }] },
      },
      { ...valid, id: 'bad-field', match: { all: [{ field: 'ip', op: 'present' }] } },
      {
        ...valid,
        id: 'extra-key',
        match: { all: [{ field: 'utm_source', op: 'present' }], none: [] },
      },
      { ...valid, id: 'unattributed', channel: 'unattributed' },
      {
        ...valid,
        id: 'too-many',
        match: { all: Array.from({ length: 11 }, () => ({ field: 'utm_source', op: 'present' })) },
      },
    ];
    const { rules, ignored } = parseChannelRules(rows);
    expect(rules.map((r) => r.id)).toEqual(['ok']);
    expect(ignored).toEqual([
      'empty',
      'bad-op',
      'bad-field',
      'extra-key',
      'unattributed',
      'too-many',
    ]);
  });
});

// Property test: classify is deterministic and total (event-pipeline.md §8). fast-check isn't an
// approved dependency yet (SPEC §3), so this drives the same properties from a seeded generator.
describe('classify — properties', () => {
  function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const VOCAB = [
    '',
    '',
    'facebook',
    'ig',
    'google',
    'cpc',
    'email',
    'whatsapp',
    'influencer',
    '123',
    '99999999999999999999999999',
    'x y',
    'ünï',
    '<script>',
    ' ',
  ];
  const HOSTS = [
    '',
    'google.com',
    'google.co.in',
    'bing.com',
    'l.instagram.com',
    'shop.example.com',
    'razorpay.com',
    'blog.example.org',
    'evil.com',
  ];
  const OPS = ['eq', 'in', 'contains', 'starts_with', 'present', 'absent'] as const;
  const FIELDS = [
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_content',
    'utm_term',
    'referrer_host',
    'click_id_type',
  ] as const;

  it('always returns a valid, consistent classification, independent of rule order', () => {
    const rand = mulberry32(20260928);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

    for (let i = 0; i < 2000; i += 1) {
      const landing = L({
        utm_source: pick(VOCAB),
        utm_medium: pick(VOCAB),
        utm_campaign: pick(VOCAB),
        utm_content: pick(VOCAB),
        utm_term: pick(VOCAB),
        fbclid: rand() < 0.2 ? 'f' : '',
        gclid: rand() < 0.2 ? 'g' : '',
        gbraid: rand() < 0.05 ? 'b' : '',
        wbraid: rand() < 0.05 ? 'w' : '',
        referrer_host: pick(HOSTS),
      });
      const rules: ChannelRule[] = Array.from({ length: Math.floor(rand() * 5) }, (_, n) => ({
        id: `r${n}`,
        priority: Math.floor(rand() * 3),
        channel: pick(CHANNEL_SLUGS),
        sub_channel: pick(VOCAB),
        match: {
          all: [
            {
              field: pick(FIELDS),
              op: pick(OPS),
              value: rand() < 0.5 ? pick(VOCAB) : [pick(VOCAB), pick(VOCAB)],
            },
          ],
        },
      }));

      const a = classify(landing, rules, ctx);
      expect(classify(landing, rules, ctx)).toEqual(a);
      expect(classify(landing, [...rules].reverse(), ctx)).toEqual(a);

      expect(CHANNEL_SLUGS).toContain(a.channel);
      expect(a.is_direct).toBe(a.channel === 'direct' ? 1 : 0);
      expect(a.platform).toBe(
        a.channel === 'meta_ads' ? 'meta' : a.channel === 'google_ads' ? 'google' : null,
      );
      for (const id of [a.campaign_id, a.adset_id, a.ad_id]) expect(id).toMatch(/^(\d{1,24})?$/);
      if (a.platform === null) {
        expect([a.campaign_id, a.adset_id, a.ad_id, a.click_id_type]).toEqual(['', '', '', '']);
      }
    }
  });
});
