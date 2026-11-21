import { describe, expect, it } from 'vitest';

import {
  classifyAll,
  classifyIp,
  decodeIpv4Mapped,
  ipFamily,
  isIpLiteral,
  stripIpv6Brackets,
  stripZoneId,
} from '../../../../src/modules/extraction/http/ip-guard.js';

describe('classifyIp — IPv4 ranges', () => {
  const unsafe: ReadonlyArray<readonly [string, string]> = [
    ['0.0.0.0', 'this-network'],
    ['0.1.2.3', 'this-network'],
    ['10.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['100.64.0.1', 'cgnat'],
    ['100.127.255.255', 'cgnat'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['169.254.169.254', 'link-local / cloud metadata'],
    ['169.254.0.1', 'link-local'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.0.0.1', 'protocol-assignment'],
    ['192.0.2.1', 'documentation'],
    ['192.168.1.1', 'private'],
    ['198.18.0.1', 'benchmarking'],
    ['198.19.255.255', 'benchmarking'],
    ['198.51.100.1', 'documentation'],
    ['203.0.113.1', 'documentation'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'broadcast'],
  ];

  for (const [address, label] of unsafe) {
    it(`denies ${address} (${label})`, () => {
      expect(classifyIp(address).safe).toBe(false);
    });
  }

  const safe = ['93.184.216.34', '8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.128.0.1'];
  for (const address of safe) {
    it(`allows public address ${address}`, () => {
      expect(classifyIp(address).safe).toBe(true);
    });
  }

  it('treats the 172.16/12 boundaries correctly', () => {
    expect(classifyIp('172.15.255.255').safe).toBe(true);
    expect(classifyIp('172.16.0.0').safe).toBe(false);
    expect(classifyIp('172.31.255.255').safe).toBe(false);
    expect(classifyIp('172.32.0.0').safe).toBe(true);
  });
});

describe('classifyIp — IPv6 ranges', () => {
  const unsafe = [
    '::1',
    '::',
    'fe80::1',
    'febf::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    'ff05::2',
    '2001:db8::1',
  ];
  for (const address of unsafe) {
    it(`denies ${address}`, () => {
      expect(classifyIp(address).safe).toBe(false);
    });
  }

  it('allows a global unicast address', () => {
    expect(classifyIp('2606:4700::1111').safe).toBe(true);
  });
});

describe('classifyIp — IPv4-mapped IPv6', () => {
  it('denies ::ffff:127.0.0.1 in dotted form', () => {
    expect(classifyIp('::ffff:127.0.0.1').safe).toBe(false);
  });

  it('denies ::ffff:7f00:1 in the hex form URL normalises to', () => {
    expect(classifyIp('::ffff:7f00:1').safe).toBe(false);
  });

  it('denies a mapped private address', () => {
    expect(classifyIp('::ffff:c0a8:101').safe).toBe(false);
  });

  it('denies the mapped metadata address', () => {
    expect(classifyIp('::ffff:169.254.169.254').safe).toBe(false);
  });

  it('allows a mapped public address', () => {
    expect(classifyIp('::ffff:8.8.8.8').safe).toBe(true);
  });
});

describe('classifyIp — zone identifiers and brackets', () => {
  it('denies a link-local address carrying a zone', () => {
    expect(classifyIp('fe80::1%eth0').safe).toBe(false);
  });

  it('denies a link-local address carrying a URL-encoded zone', () => {
    expect(classifyIp('fe80::1%25eth0').safe).toBe(false);
  });

  it('denies a bracketed loopback literal', () => {
    expect(classifyIp('[::1]').safe).toBe(false);
  });

  it('denies a bracketed mapped literal', () => {
    expect(classifyIp('[::ffff:127.0.0.1]').safe).toBe(false);
  });

  it('denies a zone identifier even on a would-be public address', () => {
    // A zone has no legitimate use in an article URL, and stripping it would
    // let this through on the strength of the base address alone.
    expect(classifyIp('2606:4700::1111%eth0').safe).toBe(false);
  });
});

describe('classifyAll', () => {
  it('denies the whole set when any address is unsafe', () => {
    expect(classifyAll(['8.8.8.8', '127.0.0.1']).safe).toBe(false);
  });

  it('denies the whole set when the unsafe address is last', () => {
    expect(classifyAll(['1.1.1.1', '93.184.216.34', '10.0.0.1']).safe).toBe(false);
  });

  it('allows a set that is entirely public', () => {
    expect(classifyAll(['8.8.8.8', '1.1.1.1']).safe).toBe(true);
  });

  it('denies an empty set', () => {
    expect(classifyAll([]).safe).toBe(false);
  });
});

describe('helpers', () => {
  it('strips IPv6 brackets', () => {
    expect(stripIpv6Brackets('[::1]')).toBe('::1');
    expect(stripIpv6Brackets('example.com')).toBe('example.com');
  });

  it('strips zone identifiers', () => {
    expect(stripZoneId('fe80::1%eth0')).toBe('fe80::1');
    expect(stripZoneId('fe80::1')).toBe('fe80::1');
  });

  it('decodes both IPv4-mapped spellings', () => {
    expect(decodeIpv4Mapped('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(decodeIpv4Mapped('::ffff:7f00:1')).toBe('127.0.0.1');
    expect(decodeIpv4Mapped('::ffff:c0a8:101')).toBe('192.168.1.1');
  });

  it('returns null for addresses that are not IPv4-mapped', () => {
    expect(decodeIpv4Mapped('::1')).toBeNull();
    expect(decodeIpv4Mapped('2001:db8::1')).toBeNull();
  });

  it('recognises IP literals, including bracketed IPv6', () => {
    expect(isIpLiteral('[::1]')).toBe(true);
    expect(isIpLiteral('127.0.0.1')).toBe(true);
    expect(isIpLiteral('example.com')).toBe(false);
  });

  it('reports the family of a literal', () => {
    expect(ipFamily('127.0.0.1')).toBe(4);
    expect(ipFamily('[::1]')).toBe(6);
  });
});
