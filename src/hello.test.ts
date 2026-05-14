import { describe, it, expect } from 'vitest';
import { greet } from './hello';

describe('greet', () => {
  it('returns a greeting for "world"', () => {
    expect(greet('world')).toBe('Hello, world!');
  });

  it('returns a greeting for "Alice"', () => {
    expect(greet('Alice')).toBe('Hello, Alice!');
  });
});
