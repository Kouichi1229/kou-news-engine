import { z } from 'zod';

/**
 * Protocols an article link may use. Relative links are resolved against the
 * feed URL first, so a feed cannot smuggle in `javascript:` or `data:` URLs.
 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export function isHttpUrl(value: string): boolean {
  try {
    return ALLOWED_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * Absolute http(s) URL.
 *
 * `z.url()` alone accepts non-http schemes such as `javascript:` and `data:`,
 * so the protocol allowlist is enforced here. The refine body must not throw:
 * zod runs refinements even when the base check has already failed.
 */
const httpUrlSchema = z.url().refine(isHttpUrl, {
  message: 'must be an absolute http(s) URL',
});

const sourceIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'must be lowercase kebab-case (a-z, 0-9, single hyphens)',
  });

export const sourceSchema = z.object({
  id: sourceIdSchema,
  name: z.string().min(1),
  /** Feed URL; also the base for resolving relative entry links. */
  url: httpUrlSchema,
  homepage: httpUrlSchema,
  kind: z.enum(['rss', 'atom', 'auto']),
  enabled: z.boolean(),
  defaultLanguage: z.string().min(1),
  tags: z.array(z.string().min(1)),
  reliability: z.enum(['high', 'medium']),
});

export type FeedSource = z.infer<typeof sourceSchema>;

export const sourceListSchema = z.array(sourceSchema).superRefine((sources, ctx) => {
  const seen = new Set<string>();

  sources.forEach((source, index) => {
    if (seen.has(source.id)) {
      ctx.addIssue({
        code: 'custom',
        path: [index, 'id'],
        message: `duplicate source id: ${source.id}`,
      });
    }
    seen.add(source.id);
  });
});

export function loadSources(input: unknown): FeedSource[] {
  return sourceListSchema.parse(input);
}
