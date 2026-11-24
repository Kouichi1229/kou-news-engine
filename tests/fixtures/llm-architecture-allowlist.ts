/**
 * Closed allow-lists for the T-10a assertion 5 static architecture scan
 * (design §9.5.3.5a).
 *
 * The list is a checked-in artifact so the evidence is reviewable rather than a
 * claim in prose. It is a closed set: adding a dependency requires an explicit
 * edit to this file under review. An unlisted bare specifier on a non-type-only
 * edge in an analysed module fails the scan, and an entry whose specifier no
 * longer appears in the closure is a stale-entry failure.
 *
 * Each entry authorises one specifier, on one kind of edge, from one origin.
 * `type-only` is never a `kind` here: a type-only edge carries no executable
 * dependency, so it is recorded in the scan report as `excluded: 'type-only'`
 * and is exempt from listing under rule B6a.
 */

/** Which analysis an entry belongs to. */
export type AllowlistPart = 'A' | 'B';

/**
 * Edge kinds an entry may authorise.
 *
 * Deliberately narrower than the scan report's edge-kind vocabulary: the report
 * also carries `type-only`, which is a valid report value but never a valid
 * allow-list kind (§9.5.3.5a).
 */
export type AllowlistEdgeKind = 'static-import' | 're-export' | 'require' | 'dynamic-import';

/** One allow-list entry: five required fields, no defaults. */
export interface ArchitectureAllowlistEntry {
  /** The exact module specifier as written in source. */
  readonly specifier: string;
  /** `'A'` for the adapter closure, `'B'` for the production wiring closure. */
  readonly part: AllowlistPart;
  /** Originating module as a repo-relative path, or a callback-unit identifier. */
  readonly origin: string;
  /** The edge kind this entry permits. `type-only` is never an entry. */
  readonly kind: AllowlistEdgeKind;
  /** Why the specifier is permitted, specific enough to check without reading code. */
  readonly reason: string;
}

/**
 * The production allow-list.
 *
 * Part A carries no entries: the adapter closure is `gemini.provider.ts` and
 * `llm.errors.ts`, and neither names a bare specifier on a value-level edge.
 *
 * Part B carries exactly one entry. `gemini.transport.ts` is the designated
 * transport and the sole module permitted to open a socket (§9.5.3.2), so its
 * `node:https` request function is the one bare specifier on a non-type-only
 * edge in an analysed module. Its `node:http` import is type-only and is
 * therefore recorded as excluded rather than listed (rule B6a), and
 * `express` appears only on the type-only edge in `runtime.ts`, so it is
 * likewise excluded rather than listed.
 */
export const architectureAllowlist: readonly ArchitectureAllowlistEntry[] = [
  {
    specifier: 'node:https',
    part: 'B',
    origin: 'src/core/llm/providers/gemini.transport.ts',
    kind: 'static-import',
    reason:
      'The designated transport is the single HTTP egress point of the LLM layer (§9.5.3.2); its node:https request function is the one call that opens a socket, and no other module in the part B closure may import it.',
  },
];
