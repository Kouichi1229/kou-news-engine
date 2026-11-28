/**
 * Processing State constants.
 *
 * Only values the Owner has already decided live here. Anything the approved
 * documents leave `OPEN` — the terminal-reason vocabulary (`CLM-9`, L-01), the
 * lease duration (`SPEC-GAP-08`), the cancellation timing (`SPEC-GAP-08`) —
 * stays a parameter, so no default in this module can silently become policy.
 */

/** `CLM-10`: each Processing version has its own budget of three claims. */
export const MAX_PROCESSING_ATTEMPTS = 3;
