import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@truepath/attribution', () => {
  it('exposes a package identity as a smoke test for the build/test pipeline', () => {
    expect(PACKAGE_NAME).toBe('@truepath/attribution');
  });
});
