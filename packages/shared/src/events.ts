import { z } from 'zod';
import { ChannelSlug, type CHANNEL_SLUGS } from './valueLists.js';

// Event enrichment and channel classification (event-pipeline.md §2.2, §2.3, §4.3): pure functions, no
// I/O, so `event-workers` and any later reporting code share one implementation. Nothing here sees a
// raw identifier — only the sanitised page URL and referrer the Collector already stripped.

export type Channel = (typeof CHANNEL_SLUGS)[number];

export const CLICK_ID_FIELDS = ['fbclid', 'gclid', 'gbraid', 'wbraid'] as const;
export type ClickIdType = (typeof CLICK_ID_FIELDS)[number] | '';

/** What a page load says about where the visitor came from. UTMs are lowercased and trimmed. */
export type Landing = {
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  utm_term: string;
  // Click ids keep their original case: `fbc` is built from `fbclid` and Meta treats it as case-sensitive.
  fbclid: string;
  gclid: string;
  gbraid: string;
  wbraid: string;
  /** Lowercased host of the sanitised referrer, `www.` stripped; '' when absent or unparsable. */
  referrer_host: string;
};

export type Classification = {
  channel: Channel;
  sub_channel: string;
  platform: 'meta' | 'google' | null;
  campaign_id: string;
  adset_id: string;
  ad_id: string;
  click_id_type: ClickIdType;
  is_direct: 0 | 1;
};

// --- parsing ---------------------------------------------------------------------------------------

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function normaliseHost(host: string): string {
  const h = host.trim().toLowerCase();
  return h.startsWith('www.') ? h.slice(4) : h;
}

export function parseLanding(pageUrl: string, referrer: string): Landing {
  const params = safeUrl(pageUrl)?.searchParams;
  const utm = (name: string): string => (params?.get(name) ?? '').trim().toLowerCase();
  const id = (name: string): string => (params?.get(name) ?? '').trim();
  return {
    utm_source: utm('utm_source'),
    utm_medium: utm('utm_medium'),
    utm_campaign: utm('utm_campaign'),
    utm_content: utm('utm_content'),
    utm_term: utm('utm_term'),
    fbclid: id('fbclid'),
    gclid: id('gclid'),
    gbraid: id('gbraid'),
    wbraid: id('wbraid'),
    referrer_host: normaliseHost(safeUrl(referrer)?.hostname ?? ''),
  };
}

/** The click id present, in the order fbclid, gclid, gbraid, wbraid ('' when none). */
export function clickIdType(l: Landing): ClickIdType {
  for (const field of CLICK_ID_FIELDS) if (l[field] !== '') return field;
  return '';
}

/**
 * Meta's server-side `fbc` format (`fb.<subdomainIndex>.<creationTime ms>.<fbclid>`, subdomainIndex 1;
 * https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/fbp-and-fbc). Used only
 * when the pixel sent no `fbc` of its own; `creationTime` is the landing event's `occurred_at`.
 */
export function resolveFbc(
  existingFbc: string | undefined,
  landing: Landing,
  occurredAtMs: number,
): string {
  if (existingFbc !== undefined && existingFbc !== '') return existingFbc;
  if (landing.fbclid === '') return '';
  return `fb.1.${Math.floor(occurredAtMs)}.${landing.fbclid}`;
}

// --- referrers -------------------------------------------------------------------------------------

/** Payment-gateway return hosts: treated as "no referrer" so a return from a payment page can't start a
 * new `referral` session that steals last-click credit (event-pipeline.md §4.3). Platform-maintained
 * for MVP (§9 open question 3). */
export const IGNORABLE_REFERRER_HOSTS: readonly string[] = [
  'checkout.shopify.com',
  'shop.app',
  'razorpay.com',
  'api.razorpay.com',
  'payu.in',
  'secure.payu.in',
  'cashfree.com',
  'paytm.com',
  'securegw.paytm.in',
  'phonepe.com',
  'ccavenue.com',
  'gokwik.co',
  'shopflo.co',
];

export function isIgnorableReferrerHost(host: string, shopHosts: readonly string[]): boolean {
  const h = normaliseHost(host);
  if (h === '') return true;
  return IGNORABLE_REFERRER_HOSTS.includes(h) || shopHosts.some((s) => normaliseHost(s) === h);
}

/** The referrer host if it is a real external source, else '' (the "no referrer" case). */
export function externalReferrerHost(l: Landing, shopHosts: readonly string[]): string {
  return isIgnorableReferrerHost(l.referrer_host, shopHosts) ? '' : normaliseHost(l.referrer_host);
}

/**
 * Fingerprint of a landing's campaign parameters (event-pipeline.md §4.2):
 * `utm_source|utm_medium|utm_campaign|utm_content|utm_term|click id value`, or '' when none are present.
 */
export function campaignFingerprint(l: Landing): string {
  const clickId = l.fbclid || l.gclid || l.gbraid || l.wbraid;
  const parts = [l.utm_source, l.utm_medium, l.utm_campaign, l.utm_content, l.utm_term, clickId];
  return parts.every((p) => p === '') ? '' : parts.join('|');
}

// --- channel_rules ---------------------------------------------------------------------------------

const Field = z.enum([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'referrer_host',
  'click_id_type',
]);
const Condition = z
  .object({
    field: Field,
    op: z.enum(['eq', 'in', 'contains', 'starts_with', 'present', 'absent']),
    value: z.union([z.string().max(128), z.array(z.string().max(128)).max(50)]).optional(),
  })
  .strict();
export const ChannelRuleMatch = z
  .object({
    all: z.array(Condition).max(10).optional(),
    any: z.array(Condition).max(10).optional(),
  })
  .strict()
  .refine((m) => (m.all?.length ?? 0) + (m.any?.length ?? 0) > 0);
export type ChannelRuleMatch = z.infer<typeof ChannelRuleMatch>;
type Condition = z.infer<typeof Condition>;

export type ChannelRule = {
  id: string;
  priority: number;
  match: ChannelRuleMatch;
  channel: Channel;
  sub_channel: string;
};

/**
 * Validates `channel_rules` rows. A row that fails is skipped and its id returned so the caller can log
 * it and the health screen can show "N channel rules ignored" (event-pipeline.md §2.3).
 */
export function parseChannelRules(
  rows: readonly {
    id: string;
    priority: number;
    match: unknown;
    channel: string;
    subChannel: string | null;
  }[],
): { rules: ChannelRule[]; ignored: string[] } {
  const rules: ChannelRule[] = [];
  const ignored: string[] = [];
  for (const row of rows) {
    const match = ChannelRuleMatch.safeParse(row.match);
    const channel = ChannelSlug.safeParse(row.channel);
    if (!match.success || !channel.success) {
      ignored.push(row.id);
      continue;
    }
    rules.push({
      id: row.id,
      priority: row.priority,
      match: match.data,
      channel: channel.data,
      sub_channel: row.subChannel ?? '',
    });
  }
  return { rules, ignored };
}

function fieldValue(l: Landing, field: Condition['field']): string {
  return field === 'click_id_type' ? clickIdType(l) : l[field];
}

const fold = (s: string): string => s.trim().toLowerCase();

function conditionMatches(c: Condition, l: Landing): boolean {
  const actual = fold(fieldValue(l, c.field));
  if (c.op === 'present') return actual !== '';
  if (c.op === 'absent') return actual === '';
  if (c.value === undefined) return false;
  if (c.op === 'in') {
    const values = typeof c.value === 'string' ? [c.value] : c.value;
    return values.some((v) => fold(v) === actual);
  }
  if (typeof c.value !== 'string') return false; // eq / contains / starts_with need one string
  const expected = fold(c.value);
  if (c.op === 'eq') return actual === expected;
  if (expected === '') return false; // an empty needle would match everything
  return c.op === 'contains' ? actual.includes(expected) : actual.startsWith(expected);
}

export function ruleMatches(match: ChannelRuleMatch, l: Landing): boolean {
  const all = match.all ?? [];
  const any = match.any ?? [];
  return (
    all.every((c) => conditionMatches(c, l)) &&
    (any.length === 0 || any.some((c) => conditionMatches(c, l)))
  );
}

// --- defaults (SPEC §7.4, ordered so explicit UTMs beat referrer inference) -------------------------

const META_SOURCES = ['facebook', 'fb', 'instagram', 'ig', 'meta'];
const PAID_MEDIUMS = ['cpc', 'paid', 'paid_social'];
const SOCIAL_REFERRER_HOSTS = [
  'instagram.com',
  'l.instagram.com',
  'facebook.com',
  'm.facebook.com',
  'l.facebook.com',
  'lm.facebook.com',
];
const GOOGLE_HOST = /^google(\.[a-z]{2,3}){1,2}$/;

function hasAnyUtm(l: Landing): boolean {
  return [l.utm_source, l.utm_medium, l.utm_campaign, l.utm_content, l.utm_term].some(
    (v) => v !== '',
  );
}

function defaultChannel(
  l: Landing,
  referrerHost: string,
): { channel: Channel; sub_channel: string } {
  const metaSource = META_SOURCES.includes(l.utm_source);
  if (l.fbclid !== '' || (metaSource && PAID_MEDIUMS.includes(l.utm_medium))) {
    return { channel: 'meta_ads', sub_channel: l.utm_source || 'facebook' };
  }
  if (metaSource) return { channel: 'organic_social', sub_channel: l.utm_source };
  if (
    l.gclid !== '' ||
    l.gbraid !== '' ||
    l.wbraid !== '' ||
    (l.utm_source === 'google' && l.utm_medium === 'cpc')
  ) {
    return { channel: 'google_ads', sub_channel: l.utm_medium || 'cpc' };
  }
  if (l.utm_medium === 'email') return { channel: 'email', sub_channel: l.utm_source };
  if (l.utm_source === 'whatsapp' || l.utm_source === 'wa') {
    return { channel: 'whatsapp', sub_channel: l.utm_medium };
  }
  if (l.utm_medium === 'influencer' || l.utm_medium === 'affiliate') {
    return { channel: 'influencer_affiliate', sub_channel: l.utm_source };
  }
  if (hasAnyUtm(l)) return { channel: 'other_campaign', sub_channel: l.utm_source };
  if (referrerHost !== '') {
    if (GOOGLE_HOST.test(referrerHost) || referrerHost === 'bing.com') {
      return { channel: 'organic_search', sub_channel: referrerHost };
    }
    if (SOCIAL_REFERRER_HOSTS.includes(referrerHost)) {
      return { channel: 'organic_social', sub_channel: referrerHost };
    }
    return { channel: 'referral', sub_channel: referrerHost };
  }
  return { channel: 'direct', sub_channel: '' };
}

// Both platforms use numeric ids; a campaign *name* leaves the id empty (the raw UTMs stay on `events`
// for the UTM-health check). PMax (a gclid with no utm_content) therefore maps at campaign level only.
const NUMERIC_ID = /^\d{1,24}$/;
const numericId = (v: string): string => (NUMERIC_ID.test(v) ? v : '');

/**
 * Classifies a landing. Merchant `channel_rules` are tried first by ascending priority (ties broken by
 * id, so the result is deterministic); the first match wins. Otherwise the SPEC §7.4 defaults apply.
 * Rules and defaults see the *effective* referrer: the shop's own hosts, Shopify checkout and payment
 * gateways count as no referrer.
 */
export function classify(
  landing: Landing,
  rules: readonly ChannelRule[],
  ctx: { shopHosts: readonly string[] },
): Classification {
  const referrerHost = externalReferrerHost(landing, ctx.shopHosts);
  const effective: Landing = { ...landing, referrer_host: referrerHost };

  const rule = [...rules]
    .sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .find((r) => ruleMatches(r.match, effective));
  const { channel, sub_channel } = rule
    ? { channel: rule.channel, sub_channel: rule.sub_channel }
    : defaultChannel(effective, referrerHost);

  const platform = channel === 'meta_ads' ? 'meta' : channel === 'google_ads' ? 'google' : null;
  const ownClickId: ClickIdType =
    platform === 'meta'
      ? landing.fbclid !== ''
        ? 'fbclid'
        : ''
      : platform === 'google'
        ? googleClickId(landing)
        : '';
  return {
    channel,
    sub_channel,
    platform,
    campaign_id: platform ? numericId(landing.utm_campaign) : '',
    adset_id: platform ? numericId(landing.utm_content) : '',
    ad_id: platform ? numericId(landing.utm_term) : '',
    click_id_type: ownClickId,
    is_direct: channel === 'direct' ? 1 : 0,
  };
}

function googleClickId(l: Landing): ClickIdType {
  if (l.gclid !== '') return 'gclid';
  if (l.gbraid !== '') return 'gbraid';
  if (l.wbraid !== '') return 'wbraid';
  return '';
}
