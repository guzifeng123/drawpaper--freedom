import { describe, it, expect } from 'vitest';
import { cn } from './lib/utils';

describe('web shell', () => {
  it('cn merges classes', () => {
    expect(cn('a', 'b')).toBe('a b');
  });
});
