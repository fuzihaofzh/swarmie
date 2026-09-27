import { describe, expect, it } from 'vitest';
import { mostRecentSession } from '../src/web/sessionRecency';

describe('mostRecentSession', () => {
  const sessions = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('picks the candidate activated most recently', () => {
    expect(mostRecentSession(sessions, ['x', 'c', 'a'])?.id).toBe('c');
  });

  it('falls back to the first candidate when none were activated before', () => {
    expect(mostRecentSession(sessions, ['x', 'y'])?.id).toBe('a');
  });

  it('returns undefined for no candidates', () => {
    expect(mostRecentSession([], ['a'])).toBeUndefined();
  });
});
