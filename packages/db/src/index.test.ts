import { describe, expect, it } from 'vitest';
import { schema } from './index.js';

describe('@truepath/db', () => {
  it('re-exports the schema', () => {
    expect(schema.stores).toBeDefined();
    expect(schema.organizations).toBeDefined();
  });
});
