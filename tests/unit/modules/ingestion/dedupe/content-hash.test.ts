import { describe, expect, it } from 'vitest';

import { contentHash } from '../../../../../src/modules/ingestion/dedupe/content-hash.js';

describe('contentHash', () => {
  it('returns a 64 character lowercase hex digest', () => {
    const hash = contentHash({ titleKey: 'a title' });

    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches a known vector so the algorithm cannot drift silently', () => {
    // sha256('a title' + U+0000), computed independently of this module.
    expect(contentHash({ titleKey: 'a title' })).toBe(
      'c1c780e828e20e5208a0a96bd8eb0e811e16ca41353003babf9b2afdf9d936f7',
    );
  });

  it('is deterministic', () => {
    const input = { titleKey: 'same', summaryText: 'text' };

    expect(contentHash(input)).toBe(contentHash(input));
  });

  it('changes when the title key changes', () => {
    expect(contentHash({ titleKey: 'one' })).not.toBe(contentHash({ titleKey: 'two' }));
  });

  it('changes when the summary changes', () => {
    expect(contentHash({ titleKey: 't', summaryText: 'a' })).not.toBe(
      contentHash({ titleKey: 't', summaryText: 'b' }),
    );
  });

  it('treats an absent summary and an empty summary as the same content', () => {
    // Deliberate: the payload uses `summaryText ?? ''`, so a feed that omits the
    // summary and one that supplies an empty summary describe the same content.
    expect(contentHash({ titleKey: 't' })).toBe(contentHash({ titleKey: 't', summaryText: '' }));
  });

  it('does not collide when a field boundary moves', () => {
    expect(contentHash({ titleKey: 'ab', summaryText: 'c' })).not.toBe(
      contentHash({ titleKey: 'a', summaryText: 'bc' }),
    );
  });

  it('handles non-ASCII content', () => {
    expect(contentHash({ titleKey: '人工智慧', summaryText: '摘要' })).toMatch(/^[0-9a-f]{64}$/);
  });
});
