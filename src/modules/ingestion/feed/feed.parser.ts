import { XMLParser, XMLValidator } from 'fast-xml-parser';

export type FeedFormat = 'rss' | 'atom';
export type SourceKind = FeedFormat | 'auto';

export class FeedParseError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'FeedParseError';
    this.code = code;
  }
}

export interface ParsedFeedEntry {
  title?: string;
  /** Link exactly as it appears in the feed; may be relative. */
  link?: string;
  guid?: string;
  /** Summary/description as yielded by the parser. */
  summary?: string;
  /** Publication date string exactly as supplied by the feed. */
  publishedRaw?: string;
  author?: string;
  categories?: string[];
  imageUrl?: string;
}

export interface ParsedFeed {
  format: FeedFormat;
  language?: string;
  entries: ParsedFeedEntry[];
}

const XML_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Feeds are untrusted input: entity expansion stays off. Entities therefore
  // remain literal in the parsed values and are decoded later, in the mapper.
  processEntities: false,
  trimValues: true,
  // Keep values as strings so identifiers and dates are not coerced to numbers.
  parseTagValue: false,
  removeNSPrefix: false,
} as const;

const DOCTYPE_PATTERN = /<!DOCTYPE/i;

const parser = new XMLParser(XML_OPTIONS);

type XmlNode = Record<string, unknown>;

function isNode(value: unknown): value is XmlNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

/** Reads the text content of a node that may be a plain string or `{ '#text': ... }`. */
function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.length > 0 ? value : undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (isNode(value)) {
    return textOf(value['#text']);
  }
  return undefined;
}

function nonEmpty(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => value !== undefined);
}

const ATOM_NAMESPACE = 'http://www.w3.org/2005/Atom';
const DUBLIN_CORE_NAMESPACE = 'http://purl.org/dc/elements/1.1/';
const MEDIA_RSS_NAMESPACE = 'http://search.yahoo.com/mrss/';
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';

const XMLNS_ATTRIBUTE = '@_xmlns';
const XMLNS_PREFIX = '@_xmlns:';

/**
 * The namespace of an element or attribute.
 *
 * - a string is a namespace URI
 * - `null` means "in no namespace"
 * - `undefined` means "bound to a prefix that is not declared", which must never
 *   satisfy a lookup
 */
type Namespace = string | null | undefined;

/**
 * The namespace declarations in effect at one element, chained to its ancestors.
 *
 * Scopes are immutable and built per branch, so a rebinding inside one entry
 * cannot leak into a sibling.
 */
interface NsScope {
  readonly parent: NsScope | undefined;
  /** prefix -> URI; the empty string is the default namespace. */
  readonly bindings: ReadonlyMap<string, string>;
}

function splitQualifiedName(name: string): { prefix: string; localName: string } {
  const separator = name.indexOf(':');
  if (separator === -1) {
    return { prefix: '', localName: name };
  }
  return { prefix: name.slice(0, separator), localName: name.slice(separator + 1) };
}

/** Reads the namespace declarations that an element itself carries. */
function ownBindings(node: XmlNode): Map<string, string> {
  const bindings = new Map<string, string>();

  for (const [key, value] of Object.entries(node)) {
    if (typeof value !== 'string') {
      continue;
    }
    if (key === XMLNS_ATTRIBUTE) {
      bindings.set('', value);
      continue;
    }
    if (key.startsWith(XMLNS_PREFIX)) {
      bindings.set(key.slice(XMLNS_PREFIX.length), value);
    }
  }

  return bindings;
}

/**
 * Builds the scope in effect for an element, including its own declarations.
 *
 * A declaration applies to the element's own name, so callers resolve the
 * element name against the returned scope rather than against `parent`.
 */
function scopeFor(node: XmlNode, parent: NsScope | undefined): NsScope {
  const bindings = ownBindings(node);
  if (bindings.size === 0 && parent !== undefined) {
    return parent;
  }
  return { parent, bindings };
}

function scopeOf(value: unknown, parent: NsScope): NsScope {
  return scopeFor(isNode(value) ? value : {}, parent);
}

/**
 * Resolves a prefix through the scope chain; the nearest declaration wins, which
 * gives descendant shadowing for free.
 *
 * `undefined` means the prefix was never declared or was explicitly unbound with
 * `xmlns=""`. Both must fail to match any lookup.
 */
function resolvePrefix(scope: NsScope | undefined, prefix: string): string | undefined {
  // `xml` is reserved and implicitly bound, so `xml:lang` needs no declaration.
  if (prefix === 'xml') {
    return XML_NAMESPACE;
  }

  for (let current = scope; current !== undefined; current = current.parent) {
    const uri = current.bindings.get(prefix);
    if (uri !== undefined) {
      return uri === '' ? undefined : uri;
    }
  }

  return undefined;
}

/** Namespace of an element name; an unprefixed name uses the default namespace. */
function elementNamespace(scope: NsScope, qualifiedName: string): Namespace {
  const { prefix } = splitQualifiedName(qualifiedName);

  if (prefix !== '') {
    return resolvePrefix(scope, prefix);
  }

  const defaultNamespace = resolvePrefix(scope, '');
  return defaultNamespace === undefined ? null : defaultNamespace;
}

/**
 * Namespace of an attribute name.
 *
 * Per the XML namespaces spec the default namespace never applies to attributes,
 * so an unprefixed attribute is in no namespace.
 */
function attributeNamespace(scope: NsScope, qualifiedName: string): Namespace {
  const { prefix } = splitQualifiedName(qualifiedName);
  return prefix === '' ? null : resolvePrefix(scope, prefix);
}

interface ElementEntry {
  value: unknown;
  namespace: Namespace;
  localName: string;
}

/**
 * Enumerates child elements, resolving each one individually.
 *
 * Repeated names collapse into an array; every member is resolved separately
 * because a rebinding applies per element, so neither the first nor the last
 * match can be assumed representative.
 */
function childElements(node: XmlNode, nodeScope: NsScope): ElementEntry[] {
  const entries: ElementEntry[] = [];

  for (const [key, value] of Object.entries(node)) {
    // Skip attributes, text and processing instructions such as `?xml`.
    if (key.startsWith('@_') || key.startsWith('?') || key === '#text') {
      continue;
    }

    for (const item of asArray(value)) {
      const childScope = scopeOf(item, nodeScope);
      entries.push({
        value: item,
        namespace: elementNamespace(childScope, key),
        localName: splitQualifiedName(key).localName,
      });
    }
  }

  return entries;
}

function findChildren(
  node: XmlNode,
  nodeScope: NsScope,
  namespace: Namespace,
  localName: string,
): unknown[] {
  return childElements(node, nodeScope)
    .filter((entry) => entry.namespace === namespace && entry.localName === localName)
    .map((entry) => entry.value);
}

function findChild(
  node: XmlNode,
  nodeScope: NsScope,
  namespace: Namespace,
  localName: string,
): unknown {
  return findChildren(node, nodeScope, namespace, localName)[0];
}

/** Reads an attribute by namespace and local name. */
function findAttribute(
  node: XmlNode,
  nodeScope: NsScope,
  namespace: Namespace,
  localName: string,
): string | undefined {
  for (const [key, value] of Object.entries(node)) {
    if (!key.startsWith('@_') || key === XMLNS_ATTRIBUTE || key.startsWith(XMLNS_PREFIX)) {
      continue;
    }

    const qualifiedName = key.slice(2);
    if (splitQualifiedName(qualifiedName).localName !== localName) {
      continue;
    }
    if (attributeNamespace(nodeScope, qualifiedName) === namespace) {
      return textOf(value);
    }
  }

  return undefined;
}

/** Reads an attribute of a child element, applying that element's own declarations. */
function attributeOf(
  value: unknown,
  parentScope: NsScope,
  namespace: Namespace,
  localName: string,
): string | undefined {
  return findAttribute(
    isNode(value) ? value : {},
    scopeOf(value, parentScope),
    namespace,
    localName,
  );
}

interface RootElement {
  qualifiedName: string;
  node: XmlNode;
  scope: NsScope;
}

function findRootElement(root: XmlNode): RootElement | undefined {
  for (const [key, value] of Object.entries(root)) {
    // Skip attributes, text and processing instructions such as `?xml`.
    if (key.startsWith('@_') || key.startsWith('?') || key === '#text' || !isNode(value)) {
      continue;
    }

    return { qualifiedName: key, node: value, scope: scopeFor(value, undefined) };
  }

  return undefined;
}

interface DetectedFormat {
  format: FeedFormat;
  /**
   * Namespace that core elements must be in.
   *
   * Atom is identified by its URI. A namespace-less `<feed>` keeps `null`, so its
   * core elements must also be namespace-less. RSS is never namespaced: a
   * namespaced `<rss>` root is rejected, so this is always `null` for RSS.
   */
  coreNamespace: Namespace;
}

/**
 * Determines the feed format from the root element's local name and namespace.
 *
 * RSS core elements are defined in no namespace, so a namespaced `<rss>` root is
 * a different element and is rejected rather than parsed into a silently empty
 * feed. A `feed` root is Atom only when it is bound to the Atom namespace (by
 * default or via a prefix) or to no namespace at all.
 */
function detectFormat(root: XmlNode, kind: SourceKind): DetectedFormat {
  const element = findRootElement(root);

  if (element === undefined) {
    throw new FeedParseError('UNKNOWN_FORMAT', 'Document has no root element');
  }

  const { localName } = splitQualifiedName(element.qualifiedName);
  const namespace = elementNamespace(element.scope, element.qualifiedName);
  let detected: DetectedFormat | undefined;

  if (localName === 'rss') {
    if (namespace === null) {
      detected = { format: 'rss', coreNamespace: null };
    } else {
      throw new FeedParseError(
        'UNKNOWN_FORMAT',
        namespace === undefined
          ? `Root <${element.qualifiedName}> uses an undeclared namespace prefix`
          : `Root <rss> is bound to namespace ${namespace}, but RSS must not be namespaced`,
      );
    }
  } else if (localName === 'feed') {
    if (namespace === ATOM_NAMESPACE) {
      detected = { format: 'atom', coreNamespace: ATOM_NAMESPACE };
    } else if (namespace === null) {
      // A namespace-less <feed> is ambiguous but conventionally Atom; accept it
      // so older or non-conformant feeds still parse.
      detected = { format: 'atom', coreNamespace: null };
    } else {
      throw new FeedParseError(
        'UNKNOWN_FORMAT',
        namespace === undefined
          ? `Root <${element.qualifiedName}> uses an undeclared namespace prefix`
          : `Root <feed> is bound to namespace ${namespace}, not the Atom namespace`,
      );
    }
  }

  if (detected === undefined) {
    throw new FeedParseError(
      'UNKNOWN_FORMAT',
      `Document root <${localName}> is neither <rss> nor <feed>`,
    );
  }

  if (kind !== 'auto' && kind !== detected.format) {
    throw new FeedParseError(
      'FORMAT_MISMATCH',
      `Expected ${kind} document but the root element indicates ${detected.format}`,
    );
  }

  return detected;
}

function parseRssEntry(raw: unknown, scope: NsScope): ParsedFeedEntry {
  const item = isNode(raw) ? raw : {};
  const entry: ParsedFeedEntry = {};

  const title = textOf(findChild(item, scope, null, 'title'));
  if (title !== undefined) {
    entry.title = title;
  }

  const link = textOf(findChild(item, scope, null, 'link'));
  if (link !== undefined) {
    entry.link = link;
  }

  const guid = textOf(findChild(item, scope, null, 'guid'));
  if (guid !== undefined) {
    entry.guid = guid;
  }

  const summary = textOf(findChild(item, scope, null, 'description'));
  if (summary !== undefined) {
    entry.summary = summary;
  }

  const publishedRaw = textOf(findChild(item, scope, null, 'pubDate'));
  if (publishedRaw !== undefined) {
    entry.publishedRaw = publishedRaw;
  }

  // Dublin Core is recognised by URI, so any prefix bound to it works while a
  // foreign element merely spelled `dc:creator` does not.
  const author =
    textOf(findChild(item, scope, DUBLIN_CORE_NAMESPACE, 'creator')) ??
    textOf(findChild(item, scope, null, 'author'));
  if (author !== undefined) {
    entry.author = author;
  }

  const categories = nonEmpty(
    findChildren(item, scope, null, 'category').map((value) => textOf(value)),
  );
  if (categories.length > 0) {
    entry.categories = categories;
  }

  // Media RSS is recognised by URI; its `url` attribute is unnamespaced.
  const mediaUrl = findChildren(item, scope, MEDIA_RSS_NAMESPACE, 'content')
    .map((value) => attributeOf(value, scope, null, 'url'))
    .find((url) => url !== undefined);
  const enclosureUrl = attributeOf(findChild(item, scope, null, 'enclosure'), scope, null, 'url');

  const imageUrl = mediaUrl ?? enclosureUrl;
  if (imageUrl !== undefined) {
    entry.imageUrl = imageUrl;
  }

  return entry;
}

function pickAtomLink(
  links: unknown[],
  entryScope: NsScope,
): { alternate?: string; enclosure?: string } {
  const result: { alternate?: string; enclosure?: string } = {};

  for (const link of links) {
    const href = attributeOf(link, entryScope, null, 'href');
    if (href === undefined) {
      continue;
    }

    const rel = attributeOf(link, entryScope, null, 'rel') ?? 'alternate';
    if (rel === 'alternate' && result.alternate === undefined) {
      result.alternate = href;
    }
    if (rel === 'enclosure' && result.enclosure === undefined) {
      result.enclosure = href;
    }
  }

  return result;
}

function parseAtomEntry(raw: unknown, scope: NsScope, coreNamespace: Namespace): ParsedFeedEntry {
  const entryNode = isNode(raw) ? raw : {};
  const entry: ParsedFeedEntry = {};

  const title = textOf(findChild(entryNode, scope, coreNamespace, 'title'));
  if (title !== undefined) {
    entry.title = title;
  }

  const pickedLink = pickAtomLink(findChildren(entryNode, scope, coreNamespace, 'link'), scope);
  if (pickedLink.alternate !== undefined) {
    entry.link = pickedLink.alternate;
  }

  const guid = textOf(findChild(entryNode, scope, coreNamespace, 'id'));
  if (guid !== undefined) {
    entry.guid = guid;
  }

  const summary = textOf(findChild(entryNode, scope, coreNamespace, 'summary'));
  if (summary !== undefined) {
    entry.summary = summary;
  }

  // Atom distinguishes published from updated; prefer the true publication time.
  const publishedRaw =
    textOf(findChild(entryNode, scope, coreNamespace, 'published')) ??
    textOf(findChild(entryNode, scope, coreNamespace, 'updated'));
  if (publishedRaw !== undefined) {
    entry.publishedRaw = publishedRaw;
  }

  const authorNode = findChild(entryNode, scope, coreNamespace, 'author');
  const authorName = textOf(
    findChild(
      isNode(authorNode) ? authorNode : {},
      scopeOf(authorNode, scope),
      coreNamespace,
      'name',
    ),
  );
  if (authorName !== undefined) {
    entry.author = authorName;
  }

  const categories = nonEmpty(
    findChildren(entryNode, scope, coreNamespace, 'category').map(
      (value) => attributeOf(value, scope, null, 'term') ?? textOf(value),
    ),
  );
  if (categories.length > 0) {
    entry.categories = categories;
  }

  if (pickedLink.enclosure !== undefined) {
    entry.imageUrl = pickedLink.enclosure;
  }

  return entry;
}

/**
 * Parses an RSS 2.0 or Atom document into a neutral intermediate shape.
 *
 * All `fast-xml-parser` specifics are confined to this module. `xml:base` is
 * deliberately ignored in this milestone: relative links are resolved against
 * the configured feed URL by the mapper.
 */
export function parseFeed(xml: string, kind: SourceKind): ParsedFeed {
  if (DOCTYPE_PATTERN.test(xml)) {
    throw new FeedParseError('DOCTYPE_NOT_ALLOWED', 'Documents must not declare a DOCTYPE');
  }

  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new FeedParseError(
      'INVALID_XML',
      `Malformed XML at line ${validation.err.line}, column ${validation.err.col}: ${validation.err.msg}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown parse error';
    throw new FeedParseError('INVALID_XML', message);
  }

  const root: XmlNode = isNode(parsed) ? parsed : {};
  const { format, coreNamespace } = detectFormat(root, kind);

  const element = findRootElement(root);
  const container = element?.node ?? {};
  const containerScope = element?.scope ?? scopeFor({}, undefined);

  if (format === 'rss') {
    const channel = findChild(container, containerScope, null, 'channel');
    const channelNode = isNode(channel) ? channel : {};
    const channelScope = scopeOf(channel, containerScope);

    const language = textOf(findChild(channelNode, channelScope, null, 'language'));
    const entries = findChildren(channelNode, channelScope, null, 'item').map((item) =>
      parseRssEntry(item, scopeOf(item, channelScope)),
    );

    return language === undefined ? { format, entries } : { format, language, entries };
  }

  // `xml:lang` is resolved through the reserved XML namespace, so an unrelated
  // `foo:lang` attribute can never stand in for it.
  const language = findAttribute(container, containerScope, XML_NAMESPACE, 'lang');
  const entries = findChildren(container, containerScope, coreNamespace, 'entry').map((entry) =>
    parseAtomEntry(entry, scopeOf(entry, containerScope), coreNamespace),
  );

  return language === undefined ? { format, entries } : { format, language, entries };
}
