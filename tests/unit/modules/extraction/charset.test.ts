import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';

import {
  charsetFromBom,
  charsetFromContentType,
  charsetFromMeta,
  decodeBody,
  isHtmlContentType,
  looksMisDecoded,
} from '../../../../src/modules/extraction/http/charset.js';

describe('charsetFromContentType', () => {
  it('reads a plain charset parameter', () => {
    expect(charsetFromContentType('text/html; charset=utf-8')).toBe('utf-8');
  });

  it('reads a quoted charset parameter', () => {
    expect(charsetFromContentType('text/html; charset="big5"')).toBe('big5');
  });

  it('is case-insensitive on the parameter name and value', () => {
    expect(charsetFromContentType('text/html; CHARSET=GBK')).toBe('gbk');
  });

  it('returns null when the parameter is absent', () => {
    expect(charsetFromContentType('text/html')).toBeNull();
  });

  it('returns null for a missing header', () => {
    expect(charsetFromContentType(null)).toBeNull();
  });

  it('returns null for an unsupported encoding so the next source is tried', () => {
    expect(charsetFromContentType('text/html; charset=made-up-9000')).toBeNull();
  });
});

describe('charsetFromMeta', () => {
  it('reads a meta charset declaration', () => {
    const bytes = Buffer.from('<html><head><meta charset="gbk"></head></html>');
    expect(charsetFromMeta(bytes)).toBe('gbk');
  });

  it('reads the http-equiv form', () => {
    const bytes = Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=big5">');
    expect(charsetFromMeta(bytes)).toBe('big5');
  });

  it('ignores a declaration beyond the first 1024 bytes', () => {
    const padding = 'x'.repeat(2000);
    const bytes = Buffer.from(`${padding}<meta charset="gbk">`);
    expect(charsetFromMeta(bytes)).toBeNull();
  });

  it('returns null when there is no declaration', () => {
    expect(charsetFromMeta(Buffer.from('<html></html>'))).toBeNull();
  });
});

describe('charsetFromBom', () => {
  it('detects a UTF-8 BOM', () => {
    expect(charsetFromBom(Buffer.from([0xef, 0xbb, 0xbf, 0x41]))).toBe('utf-8');
  });

  it('detects a UTF-16LE BOM', () => {
    expect(charsetFromBom(Buffer.from([0xff, 0xfe, 0x41, 0x00]))).toBe('utf-16le');
  });

  it('detects a UTF-16BE BOM', () => {
    expect(charsetFromBom(Buffer.from([0xfe, 0xff, 0x00, 0x41]))).toBe('utf-16be');
  });

  it('returns null without a BOM', () => {
    expect(charsetFromBom(Buffer.from('ABC'))).toBeNull();
  });
});

describe('decodeBody — priority order', () => {
  it('prefers the HTTP header over a conflicting meta declaration', () => {
    const html = '<html><head><meta charset="gbk"></head><body>hi</body></html>';
    const decoded = decodeBody(Buffer.from(html), 'text/html; charset=utf-8');
    expect(decoded.source).toBe('content-type');
    expect(decoded.charset).toBe('utf-8');
  });

  it('falls back to meta when the header has no charset', () => {
    const html = '<html><head><meta charset="utf-8"></head><body>hi</body></html>';
    const decoded = decodeBody(Buffer.from(html), 'text/html');
    expect(decoded.source).toBe('meta');
  });

  it('falls back to UTF-8 when nothing declares a charset', () => {
    const decoded = decodeBody(Buffer.from('<html><body>plain</body></html>'), 'text/html');
    expect(decoded.source).toBe('fallback');
    expect(decoded.charset).toBe('utf-8');
  });

  it('prefers a BOM over a meta declaration', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const html = Buffer.concat([bom, Buffer.from('<meta charset="gbk">')]);
    const decoded = decodeBody(html, 'text/html');
    expect(decoded.source).toBe('bom');
  });

  it('prefers a BOM over the HTTP header', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const decoded = decodeBody(
      Buffer.concat([bom, Buffer.from('<p>hi</p>')]),
      'text/html; charset=gbk',
    );
    expect(decoded.source).toBe('bom');
    expect(decoded.charset).toBe('utf-8');
  });

  it('decodes a UTF-16LE body as UTF-16LE when the header wrongly says UTF-8', () => {
    const text = '繁體中文新聞內容測試';
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(text, 'utf-16le')]);

    const decoded = decodeBody(bytes, 'text/html; charset=utf-8');

    expect(decoded.source).toBe('bom');
    expect(decoded.charset).toBe('utf-16le');
    expect(decoded.text).toBe(text);
    expect(decoded.text).not.toContain('\uFFFD');
  });

  it('decodes a UTF-16BE body as UTF-16BE when the header wrongly says UTF-8', () => {
    const text = '繁體中文新聞內容測試';
    const bytes = Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode(text, 'utf-16be')]);

    const decoded = decodeBody(bytes, 'text/html; charset=utf-8');

    expect(decoded.source).toBe('bom');
    expect(decoded.charset).toBe('utf-16be');
    expect(decoded.text).toBe(text);
    expect(decoded.text).not.toContain('\uFFFD');
  });

  it('prefers a UTF-16 BOM over a conflicting meta charset', () => {
    const text = '<p>繁體中文</p>';
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(text, 'utf-16le')]);

    const decoded = decodeBody(bytes, 'text/html');

    expect(decoded.source).toBe('bom');
    expect(decoded.charset).toBe('utf-16le');
  });

  it('keeps the header ahead of meta when there is no BOM', () => {
    const html = '<html><head><meta charset="big5"></head><body>hi</body></html>';
    const decoded = decodeBody(Buffer.from(html), 'text/html; charset=gbk');
    expect(decoded.source).toBe('content-type');
    expect(decoded.charset).toBe('gbk');
  });

  it('falls through an unsupported header charset to meta', () => {
    const html = '<html><head><meta charset="utf-8"></head><body>hi</body></html>';
    const decoded = decodeBody(Buffer.from(html), 'text/html; charset=made-up-encoding');
    expect(decoded.source).toBe('meta');
    expect(decoded.charset).toBe('utf-8');
  });

  it('falls through an unsupported header charset and no meta to UTF-8', () => {
    const decoded = decodeBody(Buffer.from('<p>hi</p>'), 'text/html; charset=made-up-encoding');
    expect(decoded.source).toBe('fallback');
    expect(decoded.charset).toBe('utf-8');
  });
});

describe('decodeBody — the BOM does not leak into the text', () => {
  it('drops a UTF-8 BOM', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('新聞', 'utf8')]);
    const decoded = decodeBody(bytes, 'text/html');
    expect(decoded.text).toBe('新聞');
    expect(decoded.text.startsWith('\uFEFF')).toBe(false);
  });

  it('drops a UTF-16LE BOM', () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode('新聞', 'utf-16le')]);
    const decoded = decodeBody(bytes, 'text/html');
    expect(decoded.text).toBe('新聞');
    expect(decoded.text.startsWith('\uFEFF')).toBe(false);
  });

  it('drops a UTF-16BE BOM', () => {
    const bytes = Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode('新聞', 'utf-16be')]);
    const decoded = decodeBody(bytes, 'text/html');
    expect(decoded.text).toBe('新聞');
    expect(decoded.text.startsWith('\uFEFF')).toBe(false);
  });

  it('leaves a U+FEFF inside the body alone, since it may be real content', () => {
    const text = '前\uFEFF後';
    const decoded = decodeBody(Buffer.from(text, 'utf8'), 'text/html; charset=utf-8');
    expect(decoded.text).toBe(text);
  });
});

describe('looksMisDecoded', () => {
  it('flags a body decoded under the wrong encoding', () => {
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      iconv.encode('繁體中文新聞', 'utf-16le'),
    ]);
    // What the old header-first order would have produced.
    const asUtf8 = iconv.decode(bytes, 'utf-8');
    expect(looksMisDecoded(asUtf8)).toBe(true);
  });

  it('does not flag a correct decode', () => {
    expect(looksMisDecoded('繁體中文新聞內容，一切正常。')).toBe(false);
  });

  it('tolerates a single corrupt byte in a long body', () => {
    const text = `${'正常內容'.repeat(100)}\uFFFD${'正常內容'.repeat(100)}`;
    expect(looksMisDecoded(text)).toBe(false);
  });

  it('does not flag an empty string', () => {
    expect(looksMisDecoded('')).toBe(false);
  });
});

describe('decodeBody — actual decoding', () => {
  it('decodes UTF-8 Traditional Chinese correctly', () => {
    const text = '繁體中文新聞內容';
    const decoded = decodeBody(Buffer.from(text, 'utf8'), 'text/html; charset=utf-8');
    expect(decoded.text).toBe(text);
  });

  it('decodes GBK Chinese correctly', () => {
    const text = '简体中文新闻';
    const bytes = iconv.encode(text, 'gbk');
    const decoded = decodeBody(bytes, 'text/html; charset=gbk');
    expect(decoded.text).toBe(text);
  });

  it('decodes Big5 Traditional Chinese correctly', () => {
    const text = '繁體中文新聞';
    const bytes = iconv.encode(text, 'big5');
    const decoded = decodeBody(bytes, 'text/html; charset=big5');
    expect(decoded.text).toBe(text);
  });

  it('decodes Shift_JIS Japanese correctly', () => {
    const text = '日本語のニュース';
    const bytes = iconv.encode(text, 'shift_jis');
    const decoded = decodeBody(bytes, 'text/html; charset=shift_jis');
    expect(decoded.text).toBe(text);
  });

  it('replaces undecodable bytes with U+FFFD instead of throwing', () => {
    // `0xff 0xfe` would now be read as a UTF-16LE BOM, so the fixture starts
    // with a byte that is invalid in UTF-8 without forming a BOM.
    const bytes = Buffer.from([0x41, 0xff, 0x41]);
    const decoded = decodeBody(bytes, 'text/html; charset=utf-8');
    expect(decoded.text).toContain('\uFFFD');
  });
});

describe('isHtmlContentType', () => {
  it('accepts text/html with parameters', () => {
    expect(isHtmlContentType('text/html; charset=utf-8')).toBe(true);
  });

  it('accepts application/xhtml+xml', () => {
    expect(isHtmlContentType('application/xhtml+xml')).toBe(true);
  });

  it('rejects JSON', () => {
    expect(isHtmlContentType('application/json')).toBe(false);
  });

  it('rejects plain text', () => {
    expect(isHtmlContentType('text/plain')).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(isHtmlContentType(null)).toBe(false);
  });
});
