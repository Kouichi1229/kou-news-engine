/**
 * Readiness dependency abstraction.
 *
 * A probe answers one question — "can this service accept traffic right now?" —
 * without being told what it is probing. The SQLite probe that arrives in a
 * later batch implements this interface, so the health module never imports the
 * persistence layer and never opens a connection of its own.
 *
 * `check()` is synchronous on purpose: the current dependencies (an open SQLite
 * handle) are synchronous, and a readiness endpoint that awaits a network round
 * trip would make an orchestrator's probe slower than its timeout.
 */
export interface ReadinessProbeResult {
  ready: boolean;

  /**
   * Stable, non-sensitive reason code, for example `database_closed`.
   *
   * Never SQL text, a filesystem path, or an exception message: this value is
   * serialised into an unauthenticated HTTP response.
   */
  detail?: string;
}

export interface ReadinessProbe {
  /** Key this probe's result is published under in the response `checks` object. */
  readonly name: string;

  /**
   * Reports whether the dependency is usable.
   *
   * May throw: `getReady` converts a thrown error into `not_ready` rather than
   * letting it escape, so a misbehaving probe degrades readiness instead of
   * returning a 500.
   */
  check(): ReadinessProbeResult;
}
