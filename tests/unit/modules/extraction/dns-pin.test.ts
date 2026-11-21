import { describe, expect, it, vi } from 'vitest';

import {
  createPinnedLookup,
  resolveAndValidate,
} from '../../../../src/modules/extraction/http/dns-pin.js';
import { UnsafeUrlError } from '../../../../src/modules/extraction/extraction.errors.js';
import type { ResolveFunction } from '../../../../src/modules/extraction/http/dns-pin.js';

/** A resolver that answers with a fixed list, or fails. */
function fixedResolver(addresses: Array<{ address: string; family: number }>): ResolveFunction {
  return (_hostname, _options, callback) => {
    callback(null, addresses);
  };
}

function failingResolver(): ResolveFunction {
  return (_hostname, _options, callback) => {
    const error = new Error('ENOTFOUND') as NodeJS.ErrnoException;
    error.code = 'ENOTFOUND';
    callback(error, []);
  };
}

describe('resolveAndValidate — IP literals', () => {
  it('accepts a public IPv4 literal without calling the resolver', async () => {
    const resolver = vi.fn(failingResolver());
    const target = await resolveAndValidate('93.184.216.34', resolver);
    expect(target.pinned).toEqual({ address: '93.184.216.34', family: 4 });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('rejects a loopback literal without calling the resolver', async () => {
    const resolver = vi.fn(failingResolver());
    await expect(resolveAndValidate('127.0.0.1', resolver)).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('rejects the cloud metadata literal', async () => {
    await expect(resolveAndValidate('169.254.169.254', fixedResolver([]))).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  });

  it('rejects a bracketed IPv6 loopback literal', async () => {
    await expect(resolveAndValidate('[::1]', fixedResolver([]))).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  });

  it('rejects a bracketed IPv4-mapped literal', async () => {
    await expect(
      resolveAndValidate('[::ffff:127.0.0.1]', fixedResolver([])),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('accepts a public IPv6 literal and reports family 6', async () => {
    const target = await resolveAndValidate('2606:4700::1111', fixedResolver([]));
    expect(target.pinned.family).toBe(6);
  });

  it('rejects an empty hostname', async () => {
    await expect(resolveAndValidate('', fixedResolver([]))).rejects.toBeInstanceOf(UnsafeUrlError);
  });
});

describe('resolveAndValidate — DNS answers', () => {
  it('accepts a single public answer', async () => {
    const target = await resolveAndValidate(
      'example.com',
      fixedResolver([{ address: '93.184.216.34', family: 4 }]),
    );
    expect(target.pinned.address).toBe('93.184.216.34');
  });

  it('rejects the whole answer when a private address appears first', async () => {
    await expect(
      resolveAndValidate(
        'example.com',
        fixedResolver([
          { address: '127.0.0.1', family: 4 },
          { address: '93.184.216.34', family: 4 },
        ]),
      ),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('rejects the whole answer when a private address appears last', async () => {
    // Node connects to the first entry, so ordering must not be relied on.
    await expect(
      resolveAndValidate(
        'example.com',
        fixedResolver([
          { address: '93.184.216.34', family: 4 },
          { address: '10.0.0.1', family: 4 },
        ]),
      ),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('rejects an answer mixing public IPv6 with private IPv4', async () => {
    await expect(
      resolveAndValidate(
        'example.com',
        fixedResolver([
          { address: '2606:4700::1111', family: 6 },
          { address: '192.168.1.1', family: 4 },
        ]),
      ),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('rejects an empty answer', async () => {
    await expect(resolveAndValidate('example.com', fixedResolver([]))).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  });

  it('rejects a resolver failure', async () => {
    await expect(resolveAndValidate('example.com', failingResolver())).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  });

  it('pins the first address of an all-public answer', async () => {
    const target = await resolveAndValidate(
      'example.com',
      fixedResolver([
        { address: '93.184.216.34', family: 4 },
        { address: '1.1.1.1', family: 4 },
      ]),
    );
    expect(target.pinned.address).toBe('93.184.216.34');
    expect(target.allAddresses).toHaveLength(2);
  });
});

describe('createPinnedLookup', () => {
  it('returns an array when all is true, as Node 24 requires', async () => {
    const lookup = createPinnedLookup({ address: '93.184.216.34', family: 4 });
    const result = await new Promise<unknown>((resolve) => {
      lookup('ignored.example', { all: true }, (_err, address) => {
        resolve(address);
      });
    });
    expect(result).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('returns a string plus family when all is false', async () => {
    const lookup = createPinnedLookup({ address: '93.184.216.34', family: 4 });
    const result = await new Promise<unknown>((resolve) => {
      lookup('ignored.example', { all: false }, (_err, address, family) => {
        resolve({ address, family });
      });
    });
    expect(result).toEqual({ address: '93.184.216.34', family: 4 });
  });

  it('ignores the hostname it is given and never resolves again', async () => {
    const lookup = createPinnedLookup({ address: '1.1.1.1', family: 4 });
    const result = await new Promise<unknown>((resolve) => {
      lookup('attacker-controlled.example', { all: true }, (_err, address) => {
        resolve(address);
      });
    });
    expect(result).toEqual([{ address: '1.1.1.1', family: 4 }]);
  });
});
