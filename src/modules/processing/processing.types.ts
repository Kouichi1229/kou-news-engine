/**
 * The three row shapes the Processing State schema can verify.
 *
 * `CLM-1` makes `terminal_reason IS NOT NULL` the terminal marker, so
 * `terminal` means "has a marker", not "failed": a superseded or cancelled job
 * would be equally terminal. The four outcome names in §3.4 are deliberately
 * absent — that vocabulary is undecided (`CLM-9`, L-01).
 */
export type ProcessingJobState = 'pending' | 'running' | 'terminal';

/**
 * One Processing Job: a single `(lifecycle, processing_version)` pair.
 *
 * Every version has its own attempt budget, claim token and lease (`CLM-10`,
 * `A.2`). A retry stays inside one row; a new version is a new row.
 */
export interface ProcessingJob {
  readonly lifecycleId: string;
  readonly processingVersion: number;
  readonly state: ProcessingJobState;
  readonly attempts: number;
  readonly leaseOwner: string | null;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: number | null;
  readonly failureCode: string | null;
  /** Non-null exactly when the job is terminal (`CLM-1`). */
  readonly terminalReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What a successful claim hands back to the Worker. */
export interface ClaimedProcessingJob {
  readonly lifecycleId: string;
  readonly processingVersion: number;
  /** The budget already consumed, including this claim (`CLM-6`). */
  readonly attempts: number;
  readonly leaseExpiresAt: number;
}

/**
 * The Article Lifecycle, as far as the Processing State store needs it.
 *
 * `publishedVersion` is the high-water mark (`A.3`): a job below it is not
 * claimable (`CLM-19`). `abandonedAt` and `closedAt` are the two ways a
 * lifecycle stops admitting work (`CLM-18`).
 */
export interface ProcessingLifecycle {
  readonly lifecycleId: string;
  readonly articleId: string;
  readonly publishedVersion: number;
  readonly publishedRevision: number;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly abandonedAt: string | null;
}
