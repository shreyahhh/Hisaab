import { describe, expect, it } from 'vitest';
import { placeholder } from './index.js';

describe('apps/api', () => {
  it('exposes a placeholder as a smoke test for the build/test pipeline', () => {
    expect(placeholder()).toContain('not yet implemented');
  });
});
