import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import * as valueLists from './valueLists.js';

const pairs: ReadonlyArray<readonly [readonly string[], z.ZodEnum<[string, ...string[]]>]> = [
  [valueLists.STORE_PLATFORMS, valueLists.StorePlatform],
  [valueLists.INTEGRATION_PROVIDERS, valueLists.IntegrationProvider],
  [valueLists.DELIVERY_STATUSES, valueLists.DeliveryStatus],
  [valueLists.PAYMENT_METHODS, valueLists.PaymentMethod],
  [valueLists.CHANNEL_SLUGS, valueLists.ChannelSlug],
  [valueLists.DSR_TYPES, valueLists.DsrType],
  [valueLists.AUDIT_ACTIONS, valueLists.AuditAction],
  [valueLists.CAPI_EVENT_NAMES, valueLists.CapiEventName],
  [valueLists.ORDER_STATUS_SOURCES, valueLists.OrderStatusSource],
  [valueLists.CONSENT_SOURCES, valueLists.ConsentSource],
  [valueLists.STORE_STATUSES, valueLists.StoreStatus],
  [valueLists.ORGANIZATION_STATUSES, valueLists.OrganizationStatus],
  [valueLists.INTEGRATION_STATUSES, valueLists.IntegrationStatus],
  [valueLists.DSR_STATUSES, valueLists.DsrStatus],
  [valueLists.CAPI_DISPATCH_STATUSES, valueLists.CapiDispatchStatus],
];

describe('valueLists', () => {
  it('every zod enum has exactly the values of its backing array (used to build a Postgres CHECK)', () => {
    for (const [values, schema] of pairs) {
      expect([...schema.options]).toEqual([...values]);
    }
  });

  it('accepts every listed value and rejects an unknown one', () => {
    for (const [values, schema] of pairs) {
      for (const value of values) {
        expect(schema.safeParse(value).success).toBe(true);
      }
      expect(schema.safeParse('__not_a_real_value__').success).toBe(false);
    }
  });

  it('has no duplicate values within any list (would silently collapse a CHECK constraint option)', () => {
    for (const [values] of pairs) {
      expect(new Set(values).size).toBe(values.length);
    }
  });
});
