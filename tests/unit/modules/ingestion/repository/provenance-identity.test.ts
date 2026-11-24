import { describe, expect, it } from 'vitest';

import type { ArticleSourceReference } from '../../../../../src/types/article.js';
import {
  normalizeSourceReferences,
  sourceIdentityKey,
  toGuidKey,
} from '../../../../../src/modules/ingestion/repository/provenance-identity.js';

interface SourceInput {
  sourceId?: string;
  url?: string;
  resolvedUrl?: string;
  canonicalUrl?: string;
  guid?: string;
}

function source(overrides: SourceInput = {}): ArticleSourceReference {
  const reference: ArticleSourceReference = {
    sourceId: overrides.sourceId ?? 'src-a',
    url: overrides.url ?? 'https://example.com/a',
    resolvedUrl: overrides.resolvedUrl ?? 'https://example.com/a',
    canonicalUrl: overrides.canonicalUrl ?? 'https://example.com/a',
  };
  if (overrides.guid !== undefined) {
    reference.guid = overrides.guid;
  }
  return reference;
}

describe('toGuidKey', () => {
  it('maps an absent GUID to the N: sentinel', () => {
    expect(toGuidKey(undefined)).toBe('N:');
  });

  it('maps an empty GUID to V:', () => {
    expect(toGuidKey('')).toBe('V:');
  });

  it('separates an absent GUID from an empty one', () => {
    expect(toGuidKey(undefined)).not.toBe(toGuidKey(''));
  });

  it('prefixes a supplied GUID with V:', () => {
    expect(toGuidKey('guid-1')).toBe('V:guid-1');
  });

  it('does not trim or normalise the GUID', () => {
    expect(toGuidKey('  spaced  ')).toBe('V:  spaced  ');
    expect(toGuidKey(' GUID ')).toBe('V: GUID ');
  });

  it('keeps a literal N: distinct from an absent GUID', () => {
    expect(toGuidKey('N:')).toBe('V:N:');
    expect(toGuidKey('N:')).not.toBe(toGuidKey(undefined));
  });

  it('is injective over sentinel-shaped inputs', () => {
    const inputs = [undefined, '', 'N:', 'V:', 'V:N:', ':', 'a:b'];
    const keys = inputs.map((input) => toGuidKey(input));

    expect(new Set(keys).size).toBe(inputs.length);
  });
});

describe('sourceIdentityKey', () => {
  it('encodes the identity tuple as JSON', () => {
    expect(
      sourceIdentityKey(source({ sourceId: 'src-a', canonicalUrl: 'https://e/x', guid: 'g1' })),
    ).toBe(JSON.stringify(['src-a', 'https://e/x', 'V:g1']));
  });

  it('distinguishes an absent GUID from an empty one', () => {
    const absent = source({ canonicalUrl: 'https://e/x' });
    const empty = source({ canonicalUrl: 'https://e/x', guid: '' });

    expect(sourceIdentityKey(absent)).not.toBe(sourceIdentityKey(empty));
  });

  it('does not collide when a field contains the NUL character', () => {
    // Delimiter-joined encodings merge these two; JSON does not.
    const left = source({ sourceId: 'a\u0000b', canonicalUrl: 'c' });
    const right = source({ sourceId: 'a', canonicalUrl: 'b\u0000c' });

    expect(sourceIdentityKey(left)).not.toBe(sourceIdentityKey(right));
  });

  it('does not collide when a field contains the tuple separator', () => {
    const left = source({ sourceId: 'a,b', canonicalUrl: 'c' });
    const right = source({ sourceId: 'a', canonicalUrl: 'b,c' });

    expect(sourceIdentityKey(left)).not.toBe(sourceIdentityKey(right));
  });

  it('does not collide when a GUID mimics a boundary', () => {
    const left = source({ sourceId: 's', canonicalUrl: 'c', guid: 'V:x' });
    const right = source({ sourceId: 's', canonicalUrl: 'cV:', guid: 'x' });

    expect(sourceIdentityKey(left)).not.toBe(sourceIdentityKey(right));
  });
});

describe('normalizeSourceReferences — identity separation', () => {
  it('keeps an absent GUID and an empty GUID as two entries', () => {
    const normalized = normalizeSourceReferences([
      source({ canonicalUrl: 'https://e/x' }),
      source({ canonicalUrl: 'https://e/x', guid: '' }),
    ]);

    expect(normalized).toHaveLength(2);
    expect(normalized[0]?.guid).toBeUndefined();
    expect(normalized[1]?.guid).toBe('');
  });

  it('keeps the same URL under two different GUIDs', () => {
    const normalized = normalizeSourceReferences([
      source({ canonicalUrl: 'https://e/x', guid: 'g1' }),
      source({ canonicalUrl: 'https://e/x', guid: 'g2' }),
    ]);

    expect(normalized).toHaveLength(2);
    expect(normalized.map((entry) => entry.guid)).toEqual(['g1', 'g2']);
  });

  it('keeps the same GUID under two different canonical URLs', () => {
    const normalized = normalizeSourceReferences([
      source({ canonicalUrl: 'https://e/x', guid: 'g1' }),
      source({ canonicalUrl: 'https://e/y', guid: 'g1' }),
    ]);

    expect(normalized).toHaveLength(2);
    expect(normalized.map((entry) => entry.canonicalUrl)).toEqual(['https://e/x', 'https://e/y']);
  });

  it('keeps two different sourceIds apart', () => {
    const normalized = normalizeSourceReferences([
      source({ sourceId: 'src-a', canonicalUrl: 'https://e/x', guid: 'g1' }),
      source({ sourceId: 'src-b', canonicalUrl: 'https://e/x', guid: 'g1' }),
    ]);

    expect(normalized).toHaveLength(2);
    expect(normalized.map((entry) => entry.sourceId)).toEqual(['src-a', 'src-b']);
  });
});

describe('normalizeSourceReferences — merging', () => {
  it('merges two entries with the same identity', () => {
    const normalized = normalizeSourceReferences([
      source({ canonicalUrl: 'https://e/x', guid: 'g1' }),
      source({ canonicalUrl: 'https://e/x', guid: 'g1' }),
    ]);

    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.canonicalUrl).toBe('https://e/x');
  });

  it('takes the position of the first occurrence and the values of the last', () => {
    const normalized = normalizeSourceReferences([
      source({ sourceId: 'shared', canonicalUrl: 'https://e/x', guid: 'g1', url: 'https://e/one' }),
      source({ sourceId: 'other', canonicalUrl: 'https://e/y', guid: 'g2' }),
      source({
        sourceId: 'shared',
        canonicalUrl: 'https://e/x',
        guid: 'g1',
        url: 'https://e/three',
      }),
    ]);

    expect(normalized).toHaveLength(2);
    // Position 0 is held by the first occurrence...
    expect(normalized[0]?.canonicalUrl).toBe('https://e/x');
    // ...but its values come from the last occurrence.
    expect(normalized[0]?.url).toBe('https://e/three');
    expect(normalized[1]?.canonicalUrl).toBe('https://e/y');
  });

  it('keeps the first position stable across three occurrences', () => {
    const normalized = normalizeSourceReferences([
      source({ canonicalUrl: 'https://e/x', guid: 'g1', url: 'https://e/1' }),
      source({ canonicalUrl: 'https://e/x', guid: 'g1', url: 'https://e/2' }),
      source({ canonicalUrl: 'https://e/x', guid: 'g1', url: 'https://e/3' }),
    ]);

    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.url).toBe('https://e/3');
  });

  it('updates resolvedUrl from the last occurrence', () => {
    const normalized = normalizeSourceReferences([
      source({ canonicalUrl: 'https://e/x', guid: 'g1', resolvedUrl: 'https://e/old' }),
      source({ canonicalUrl: 'https://e/x', guid: 'g1', resolvedUrl: 'https://e/new' }),
    ]);

    expect(normalized[0]?.resolvedUrl).toBe('https://e/new');
  });

  it('merges several independent duplicate groups without gaps', () => {
    const normalized = normalizeSourceReferences([
      source({ sourceId: 's1', canonicalUrl: 'https://e/a', guid: 'g1', url: 'https://e/a1' }),
      source({ sourceId: 's2', canonicalUrl: 'https://e/b', guid: 'g2', url: 'https://e/b1' }),
      source({ sourceId: 's1', canonicalUrl: 'https://e/a', guid: 'g1', url: 'https://e/a2' }),
      source({ sourceId: 's3', canonicalUrl: 'https://e/c', guid: 'g3', url: 'https://e/c1' }),
      source({ sourceId: 's2', canonicalUrl: 'https://e/b', guid: 'g2', url: 'https://e/b2' }),
    ]);

    expect(normalized.map((entry) => entry.sourceId)).toEqual(['s1', 's2', 's3']);
    expect(normalized.map((entry) => entry.url)).toEqual([
      'https://e/a2',
      'https://e/b2',
      'https://e/c1',
    ]);
    // One entry per distinct identity: no index is skipped.
    expect(normalized).toHaveLength(3);
  });

  it('produces contiguous ordering that a source_order can mirror', () => {
    const normalized = normalizeSourceReferences([
      source({ canonicalUrl: 'https://e/a', guid: 'g1' }),
      source({ canonicalUrl: 'https://e/a', guid: 'g1' }),
      source({ canonicalUrl: 'https://e/b', guid: 'g2' }),
    ]);

    expect(normalized.map((_, index) => index + 1)).toEqual([1, 2]);
    expect(normalized).toHaveLength(2);
  });
});

describe('normalizeSourceReferences — empty input', () => {
  it('returns an empty array for empty sources', () => {
    expect(normalizeSourceReferences([])).toEqual([]);
  });

  it('does not substitute content for empty sources', () => {
    expect(normalizeSourceReferences([])).toHaveLength(0);
  });
});

describe('normalizeSourceReferences — input immutability', () => {
  it('does not mutate the input array', () => {
    const input = [
      source({ canonicalUrl: 'https://e/x', guid: 'g1', url: 'https://e/one' }),
      source({ canonicalUrl: 'https://e/x', guid: 'g1', url: 'https://e/two' }),
    ];
    const snapshot = JSON.parse(JSON.stringify(input));

    normalizeSourceReferences(input);

    expect(input).toHaveLength(2);
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
  });

  it('does not mutate the input objects', () => {
    const first = source({ canonicalUrl: 'https://e/x', guid: 'g1', url: 'https://e/one' });
    const second = source({ canonicalUrl: 'https://e/x', guid: 'g1', url: 'https://e/two' });

    normalizeSourceReferences([first, second]);

    expect(first.url).toBe('https://e/one');
    expect(second.url).toBe('https://e/two');
  });

  it('returns fresh objects that are not aliased to the inputs', () => {
    const input = source({ canonicalUrl: 'https://e/x', guid: 'g1' });
    const normalized = normalizeSourceReferences([input]);

    expect(normalized[0]).not.toBe(input);
    expect(normalized[0]).toEqual(input);
  });

  it('keeps the absent/present distinction on guid in the output', () => {
    const normalized = normalizeSourceReferences([source({ canonicalUrl: 'https://e/x' })]);

    expect('guid' in (normalized[0] as object)).toBe(false);
  });

  it('preserves an empty guid as present', () => {
    const normalized = normalizeSourceReferences([
      source({ canonicalUrl: 'https://e/x', guid: '' }),
    ]);

    expect('guid' in (normalized[0] as object)).toBe(true);
    expect(normalized[0]?.guid).toBe('');
  });

  it('does not let a caller corrupt a later read by mutating the result', () => {
    const normalized = normalizeSourceReferences([
      source({ canonicalUrl: 'https://e/x', guid: 'g1' }),
    ]);
    normalized[0]!.url = 'https://e/mutated';

    const again = normalizeSourceReferences([source({ canonicalUrl: 'https://e/x', guid: 'g1' })]);

    expect(again[0]?.url).toBe('https://example.com/a');
  });
});

describe('normalizeSourceReferences — determinism', () => {
  it('returns the same output for the same input', () => {
    const build = () => [
      source({ sourceId: 's1', canonicalUrl: 'https://e/a', guid: 'g1', url: 'https://e/1' }),
      source({ sourceId: 's2', canonicalUrl: 'https://e/b', guid: 'g2', url: 'https://e/2' }),
      source({ sourceId: 's1', canonicalUrl: 'https://e/a', guid: 'g1', url: 'https://e/3' }),
    ];

    expect(normalizeSourceReferences(build())).toEqual(normalizeSourceReferences(build()));
  });

  it('preserves first-appearance order of identities', () => {
    const normalized = normalizeSourceReferences([
      source({ sourceId: 's3', canonicalUrl: 'https://e/c', guid: 'g3' }),
      source({ sourceId: 's1', canonicalUrl: 'https://e/a', guid: 'g1' }),
      source({ sourceId: 's2', canonicalUrl: 'https://e/b', guid: 'g2' }),
    ]);

    expect(normalized.map((entry) => entry.sourceId)).toEqual(['s3', 's1', 's2']);
  });
});
