import { describe, expect, it } from 'vitest';
import { ApiError } from './api';

describe('ApiError', () => {
  it('carries the HTTP status and parsed body', () => {
    const err = new ApiError(403, { error: 'forbidden_role' });
    expect(err.status).toBe(403);
    expect(err.body).toEqual({ error: 'forbidden_role' });
    expect(err.message).toBe('API 403');
  });
});
