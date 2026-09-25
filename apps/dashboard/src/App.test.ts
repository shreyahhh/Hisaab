import { describe, expect, it } from 'vitest';
import { getPlaceholderMessage } from './placeholder';

describe('apps/dashboard', () => {
  it('exposes a placeholder message as a smoke test for the build/test pipeline', () => {
    expect(getPlaceholderMessage()).toContain('not yet implemented');
  });
});
