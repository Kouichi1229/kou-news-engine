/**
 * T-10a assertion 5 static architecture scanner (design §9.5.3).
 *
 * Two analyses share one edge model:
 *
 * - **Part A** (§9.5.3.1) walks the adapter's production dependency closure from
 *   `gemini.provider.ts` and proves no source-level egress exists there.
 * - **Part B** (§9.5.3.3a) walks the bounded production wiring closure from three
 *   module-level roots plus one nested callback unit, applying the participation
 *   test *before* each edge is followed, and recording every excluded edge.
 *
 * The scanner is test-only support code. Its report is an in-memory value: no
 * artifact is written. Module identity, syntactic edge identity and traversal
 * deduplication are kept separate (§9.5.3.3a) so that rule B1g is satisfiable.
 *
 * Source locations are 1-based in both components. The Compiler API reports
 * 0-based line and character indices, so one is added to each (§9.5.3.3a).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

/** Edge kinds a report may carry. `type-only` is a report value, never an allow-list kind. */
export type EdgeKind = 'static-import' | 're-export' | 'require' | 'dynamic-import' | 'type-only';

/** The seven-member closed exclusion enumeration of §11.5.4 B. */
export type ExclusionReason =
  | 'type-only'
  | 'bare-specifier'
  | 'http-composition'
  | 'persistence'
  | 'health-and-probes'
  | 'lifecycle'
  | 'not-transport-wiring';

/** The closed enumeration, in normative decision order. */
export const EXCLUSION_REASONS: readonly ExclusionReason[] = [
  'type-only',
  'bare-specifier',
  'http-composition',
  'persistence',
  'health-and-probes',
  'lifecycle',
  'not-transport-wiring',
];

/** One syntactic edge, as reported. */
export interface ScanEdge {
  readonly origin: string;
  readonly edgeKind: EdgeKind;
  readonly sourceLocation: string;
  readonly target: string;
  readonly disposition: 'followed' | 'excluded';
  readonly reason?: ExclusionReason;
}

/** One exclusion record: the five required fields of §11.5.4 B, all present. */
export interface ExclusionRecord {
  readonly origin: string;
  readonly edgeKind: EdgeKind;
  readonly sourceLocation: string;
  readonly target: string;
  readonly reason: ExclusionReason;
}

/** Result of one analysis. */
export interface ScanReport {
  readonly part: 'A' | 'B';
  readonly edges: readonly ScanEdge[];
  readonly modules: readonly string[];
  readonly failures: readonly string[];
}

/** Adapter entry point and transport boundary (§9.5.3.1, §9.5.3.2). */
export const ADAPTER_ENTRY = 'src/core/llm/providers/gemini.provider.ts';
export const TRANSPORT_BOUNDARY = 'src/core/llm/providers/gemini.transport.ts';

/** The three module-level part B roots (§9.5.3.3a). */
export const PART_B_ROOTS: readonly string[] = [
  'src/runtime.ts',
  'src/core/llm/provider.factory.ts',
  'src/core/llm/providers/gemini.transport.ts',
];

/** Modules whose value-level edges carry provider, transport or configuration wiring. */
const WIRING_ORIGINS: readonly string[] = [
  'src/core/llm/provider.factory.ts',
  'src/core/llm/providers/gemini.transport.ts',
];

/** Paths a scan may be redirected to, so controls can run over fixture trees. */
export interface ScanOptions {
  /** Adapter entry point for part A. Defaults to the production adapter. */
  readonly adapterEntry?: string;
  /** Transport boundary; never expanded by part A. */
  readonly transportBoundary?: string;
  /** The three module-level roots for part B, in order. */
  readonly roots?: readonly string[];
  /** Composition root within `roots` that hosts the callback unit. */
  readonly runtimeModule?: string;
  /** Factory module whose `deps.createTransport()` call Stage 4 resolves. */
  readonly factoryModule?: string;
  /** Entry point read as the bounded Stage 1 call-site witness. */
  readonly entryPoint?: string;
  /** Origins whose value-level edges carry wiring. */
  readonly wiringOrigins?: readonly string[];
}

/** Fully-resolved scan paths. */
export interface ResolvedOptions {
  readonly adapterEntry: string;
  readonly transportBoundary: string;
  readonly roots: readonly string[];
  readonly runtimeModule: string;
  readonly factoryModule: string;
  readonly entryPoint: string;
  readonly wiringOrigins: readonly string[];
}

/** Resolve `ScanOptions` against the production defaults. */
export function resolveOptions(options: ScanOptions = {}): ResolvedOptions {
  return {
    adapterEntry: options.adapterEntry ?? ADAPTER_ENTRY,
    transportBoundary: options.transportBoundary ?? TRANSPORT_BOUNDARY,
    roots: options.roots ?? PART_B_ROOTS,
    runtimeModule: options.runtimeModule ?? 'src/runtime.ts',
    factoryModule: options.factoryModule ?? 'src/core/llm/provider.factory.ts',
    entryPoint: options.entryPoint ?? 'src/index.ts',
    wiringOrigins: options.wiringOrigins ?? WIRING_ORIGINS,
  };
}

/** Networking specifiers that fail part A outright (§9.5.3.3). */
export const NETWORKING_SPECIFIERS: readonly string[] = [
  'node:http',
  'node:https',
  'node:net',
  'node:tls',
  'undici',
  'http2',
  'node:http2',
  'dns',
  'node:dns',
  'node:dgram',
];

/** Globals that fail part A when referenced in the adapter layer. */
export const NETWORKING_GLOBALS: readonly string[] = ['fetch', 'XMLHttpRequest', 'WebSocket'];

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

/** A source tree the scanner can analyse, real or synthetic. */
export interface ScanWorkspace {
  /** Absolute directory that contains `src/`. */
  readonly rootDir: string;
  readonly compilerOptions: ts.CompilerOptions;
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
}

function defaultCompilerOptions(): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  };
}

/** Absolute path of the repository root, derived from this file's location. */
export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** Build a workspace over the real repository. */
export function createRepoWorkspace(): ScanWorkspace {
  const rootDir = repoRoot();
  const options = defaultCompilerOptions();
  const roots = [...PART_B_ROOTS, ADAPTER_ENTRY, 'src/index.ts'].map((rel) =>
    path.join(rootDir, rel),
  );
  const program = ts.createProgram(roots, options);
  return { rootDir, compilerOptions: options, program, checker: program.getTypeChecker() };
}

/** Build a workspace over a synthetic tree written to temporary space. */
export function createFixtureWorkspace(
  files: Readonly<Record<string, string>>,
): ScanWorkspace & { readonly dispose: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'kou-arch-scan-'));
  const roots: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
    roots.push(abs);
  }
  const options = defaultCompilerOptions();
  const program = ts.createProgram(roots, options);
  return {
    rootDir: dir,
    compilerOptions: options,
    program,
    checker: program.getTypeChecker(),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Paths and locations
// ---------------------------------------------------------------------------

/** Repo-relative, POSIX-separated module path. */
function modulePath(workspace: ScanWorkspace, abs: string): string {
  return path.relative(workspace.rootDir, abs).split(path.sep).join('/');
}

/** 1-based `line:column` for a position (§9.5.3.3a). */
export function sourceLocation(sf: ts.SourceFile, pos: number): string {
  const lc = sf.getLineAndCharacterOfPosition(pos);
  return `${lc.line + 1}:${lc.character + 1}`;
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/');
}

interface Resolved {
  readonly isBare: boolean;
  /** Repo-relative module path when local, else the bare specifier itself. */
  readonly target: string;
}

function resolveSpecifier(
  workspace: ScanWorkspace,
  specifier: string,
  containingFile: string,
): Resolved | undefined {
  if (!isRelativeSpecifier(specifier)) {
    return { isBare: true, target: specifier };
  }
  const res = ts.resolveModuleName(
    specifier,
    containingFile,
    workspace.compilerOptions,
    ts.sys,
  ).resolvedModule;
  if (res === undefined) return undefined;
  return { isBare: false, target: modulePath(workspace, res.resolvedFileName) };
}

// ---------------------------------------------------------------------------
// Edge collection
// ---------------------------------------------------------------------------

interface RawEdge {
  readonly origin: string;
  readonly edgeKind: EdgeKind;
  readonly sourceLocation: string;
  readonly resolved: Resolved;
  readonly specifier: string;
}

/** True when an import clause carries at least one value-level binding. */
function clauseHasValueBinding(clause: ts.ImportClause): boolean {
  if (clause.name !== undefined) return true; // default import is a value
  const nb = clause.namedBindings;
  if (nb === undefined) return false;
  if (ts.isNamespaceImport(nb)) return true;
  return nb.elements.some((e) => !e.isTypeOnly);
}

/** True when an import clause carries at least one type-only binding. */
function clauseHasTypeBinding(clause: ts.ImportClause): boolean {
  if (clause.isTypeOnly) return true;
  const nb = clause.namedBindings;
  if (nb === undefined) return false;
  if (ts.isNamespaceImport(nb)) return false;
  return nb.elements.some((e) => e.isTypeOnly);
}

/**
 * Collect every syntactic edge of one module, splitting mixed declarations by
 * binding kind (§9.5.3.3a). Each returned edge is a distinct syntactic edge.
 */
export function collectEdges(
  workspace: ScanWorkspace,
  sf: ts.SourceFile,
  origin: string,
): RawEdge[] {
  const out: RawEdge[] = [];

  const push = (kind: EdgeKind, node: ts.Node, specifier: string): void => {
    const resolved = resolveSpecifier(workspace, specifier, sf.fileName);
    if (resolved === undefined) return;
    out.push({
      origin,
      edgeKind: kind,
      sourceLocation: sourceLocation(sf, node.getStart(sf)),
      resolved,
      specifier,
    });
  };

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const spec = stmt.moduleSpecifier;
      if (!ts.isStringLiteral(spec)) continue;
      const clause = stmt.importClause;
      if (clause === undefined) {
        push('static-import', spec, spec.text); // side-effect import
        continue;
      }
      if (clause.isTypeOnly) {
        push('type-only', spec, spec.text);
        continue;
      }
      if (clauseHasValueBinding(clause)) push('static-import', spec, spec.text);
      if (clauseHasTypeBinding(clause)) push('type-only', spec, spec.text);
      continue;
    }

    if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier !== undefined) {
      const spec = stmt.moduleSpecifier;
      if (!ts.isStringLiteral(spec)) continue;
      const allTypeOnly =
        stmt.isTypeOnly ||
        (stmt.exportClause !== undefined &&
          ts.isNamedExports(stmt.exportClause) &&
          stmt.exportClause.elements.length > 0 &&
          stmt.exportClause.elements.every((e) => e.isTypeOnly));
      push(allTypeOnly ? 'type-only' : 're-export', spec, spec.text);
      continue;
    }

    if (ts.isImportEqualsDeclaration(stmt) && ts.isExternalModuleReference(stmt.moduleReference)) {
      const expr = stmt.moduleReference.expression;
      if (ts.isStringLiteral(expr)) push('require', stmt, expr.text);
      continue;
    }

    if (ts.isCallExpression(stmt)) {
      // handled below by the general call walker
    }
  }

  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg !== undefined && ts.isStringLiteral(arg)) {
          push('dynamic-import', node, arg.text);
        } else if (arg !== undefined) {
          // computed specifier: representable as an edge with no resolvable target
          out.push({
            origin,
            edgeKind: 'dynamic-import',
            sourceLocation: sourceLocation(sf, node.getStart(sf)),
            resolved: { isBare: false, target: '<computed>' },
            specifier: '<computed>',
          });
        }
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        const arg = node.arguments[0];
        if (arg !== undefined && ts.isStringLiteral(arg)) push('require', node, arg.text);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);

  return out;
}

/** Deduplicate identical syntactic edges (same tuple) without merging distinct ones. */
function edgeKey(e: ScanEdge): string {
  return [e.origin, e.edgeKind, e.target, e.sourceLocation].join('\u0000');
}

// ---------------------------------------------------------------------------
// Part A
// ---------------------------------------------------------------------------

/** Walk the adapter closure (§9.5.3.1) and report egress findings. */
export function scanPartA(
  workspace: ScanWorkspace = createRepoWorkspace(),
  options: ScanOptions = {},
): ScanReport {
  const opt = resolveOptions(options);
  const failures: string[] = [];
  const edges: ScanEdge[] = [];
  const modules: string[] = [];
  const visited = new Set<string>();

  const queue: string[] = [opt.adapterEntry];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    if (visited.has(current)) continue;
    visited.add(current);
    modules.push(current);

    if (current === opt.transportBoundary) continue; // boundary: never expanded

    const abs = path.join(workspace.rootDir, current);
    const sf = workspace.program.getSourceFile(abs);
    if (sf === undefined) {
      failures.push(`unresolved module in part A closure: ${current}`);
      continue;
    }

    for (const raw of collectEdges(workspace, sf, current)) {
      const base: ScanEdge = {
        origin: raw.origin,
        edgeKind: raw.edgeKind,
        sourceLocation: raw.sourceLocation,
        target: raw.resolved.target,
        disposition: 'excluded',
      };

      if (raw.edgeKind === 'type-only') {
        edges.push({ ...base, reason: 'type-only' });
        continue;
      }

      if (raw.edgeKind === 'dynamic-import') {
        // Rule 4: a dynamic import inside the adapter closure is a failure.
        edges.push({ ...base, reason: 'not-transport-wiring' });
        failures.push(
          `dynamic import in adapter closure at ${current}:${raw.sourceLocation} (${raw.specifier})`,
        );
        continue;
      }

      if (raw.resolved.isBare) {
        edges.push({ ...base, reason: 'bare-specifier' });
        if (NETWORKING_SPECIFIERS.includes(raw.resolved.target)) {
          failures.push(
            `networking import '${raw.resolved.target}' in adapter closure at ${current}:${raw.sourceLocation}`,
          );
        }
        continue;
      }

      if (raw.resolved.target === opt.transportBoundary) {
        // Reaching the boundary by a value edge would be a design violation.
        edges.push({ ...base, reason: 'not-transport-wiring' });
        failures.push(
          `value-level import of the transport boundary from adapter closure at ${current}:${raw.sourceLocation}`,
        );
        continue;
      }

      edges.push({ ...base, disposition: 'followed' });
      if (!visited.has(raw.resolved.target)) queue.push(raw.resolved.target);
    }
  }

  // Global-reference check over the adapter closure.
  for (const mod of modules) {
    if (mod === opt.transportBoundary) continue;
    const sf = workspace.program.getSourceFile(path.join(workspace.rootDir, mod));
    if (sf === undefined) continue;
    const walk = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && NETWORKING_GLOBALS.includes(node.text)) {
        const parent = node.parent;
        const isPropertyName =
          (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyDeclaration(parent) && parent.name === node);
        if (!isPropertyName) {
          failures.push(
            `global '${node.text}' referenced in adapter closure at ${mod}:${sourceLocation(sf, node.getStart(sf))}`,
          );
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(sf);
  }

  return { part: 'A', edges: dedupeEdges(edges), modules, failures };
}

function dedupeEdges(edges: readonly ScanEdge[]): ScanEdge[] {
  const seen = new Set<string>();
  const out: ScanEdge[] = [];
  for (const e of edges) {
    const key = `${edgeKey(e)}\u0000${e.disposition}\u0000${e.reason ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Callback identification (§9.5.3.3b)
// ---------------------------------------------------------------------------

/** The identified callback unit. */
export interface CallbackUnit {
  /** Stable origin identifier: `<module>#createTransport@<line>:<column>`. */
  readonly origin: string;
  readonly node: ts.ArrowFunction | ts.FunctionExpression;
  readonly sourceFile: ts.SourceFile;
  /** Literal dynamic-import target module path, when the body has one. */
  readonly dynamicImportTarget?: string;
}

function findCallExpressions(
  sf: ts.SourceFile,
  pred: (call: ts.CallExpression) => boolean,
): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && pred(node)) out.push(node);
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return out;
}

function functionExpressionOf(
  checker: ts.TypeChecker,
  expr: ts.Expression,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) return expr;
  if (ts.isIdentifier(expr)) {
    const sym = checker.getSymbolAtLocation(expr);
    if (sym === undefined) return undefined;
    const decls = sym.getDeclarations() ?? [];
    if (decls.length !== 1) return undefined;
    const d = decls[0];
    if (d === undefined) return undefined;
    if (ts.isVariableDeclaration(d) && d.initializer !== undefined) {
      const init = d.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
    }
    return undefined;
  }
  return undefined;
}

/** Why the provider-factory default binding could not be established (§11.5.4 E N5). */
export type FactoryResolutionFailure =
  | 'no-nullish-declaration'
  | 'left-operand-unresolved'
  | 'right-operand-not-imported-factory'
  | 'ambiguous';

/** Outcome of resolving the `deps.createProvider ?? createProviderFromFactory` binding. */
export interface FactoryResolution {
  readonly ok: boolean;
  /** The local binding name, when resolution succeeded. */
  readonly bindingName?: string;
  readonly failure?: FactoryResolutionFailure;
  /** Human-readable explanation, suitable for a stage failure message. */
  readonly detail: string;
}

/** One `??` variable declaration, with its operands classified. */
interface FactoryCandidate {
  readonly name: string;
  readonly rightIsImportedFactory: boolean;
  readonly leftIsResolved: boolean;
}

/**
 * Resolve the provider-factory default binding through the TypeChecker rather
 * than by identifier text (§11.5.4 E N5).
 *
 * A candidate qualifies only when its initializer is a nullish-coalescing
 * expression whose right operand resolves, as an alias, to the `createProvider`
 * function exported by the factory module, and whose left operand resolves to a
 * declared binding. A declaration whose operands do not satisfy both conditions
 * is never selected, so an unrelated `??` such as `deps.llmConfig ?? { … }`
 * cannot be mistaken for the factory fallback merely because a call site has a
 * matching identifier shape.
 */
export function resolveProviderFactory(
  workspace: ScanWorkspace,
  options: ScanOptions = {},
): FactoryResolution {
  const opt = resolveOptions(options);
  const sf = workspace.program.getSourceFile(path.join(workspace.rootDir, opt.runtimeModule));
  if (sf === undefined) {
    return { ok: false, failure: 'no-nullish-declaration', detail: 'runtime module missing' };
  }
  const checker = workspace.checker;
  const factorySf = workspace.program.getSourceFile(path.join(workspace.rootDir, opt.factoryModule));

  const isImportedFactory = (node: ts.Expression): boolean => {
    if (factorySf === undefined) return false;
    const sym = checker.getSymbolAtLocation(node);
    if (sym === undefined) return false;
    if ((sym.flags & ts.SymbolFlags.Alias) === 0) return false;
    const target = checker.getAliasedSymbol(sym);
    return (target.getDeclarations() ?? []).some(
      (d) =>
        ts.isFunctionDeclaration(d) &&
        d.name?.text === 'createProvider' &&
        d.getSourceFile() === factorySf,
    );
  };

  const candidates: FactoryCandidate[] = [];
  let sawNullishDeclaration = false;
  const walk = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isBinaryExpression(node.initializer) &&
      node.initializer.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      sawNullishDeclaration = true;
      const { left, right } = node.initializer;
      const leftSym = checker.getSymbolAtLocation(left);
      candidates.push({
        name: node.name.text,
        rightIsImportedFactory: isImportedFactory(right),
        leftIsResolved: leftSym !== undefined && (leftSym.getDeclarations() ?? []).length > 0,
      });
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);

  // Every candidate whose right operand resolves to the designated factory
  // function, regardless of its left operand. Ambiguity is decided over this
  // whole set, so a resolvable candidate cannot mask a sibling that points at
  // the same factory but whose left operand is unresolved (§11.5.4 E N5).
  const designated = candidates.filter((c) => c.rightIsImportedFactory);
  const names = designated.map((c) => c.name).join(', ');

  if (designated.length > 1) {
    return {
      ok: false,
      failure: 'ambiguous',
      detail: `ambiguous provider-factory binding: ${names}`,
    };
  }

  const only = designated.length === 1 ? designated[0] : undefined;
  if (only !== undefined) {
    if (!only.leftIsResolved) {
      return {
        ok: false,
        failure: 'left-operand-unresolved',
        detail: `provider-factory ?? left operand of '${only.name}' does not resolve to a declared binding`,
      };
    }
    return {
      ok: true,
      bindingName: only.name,
      detail: `provider-factory binding '${only.name}' resolved from its ?? operands`,
    };
  }

  // No candidate resolves its right operand to the designated factory.
  if (sawNullishDeclaration) {
    return {
      ok: false,
      failure: 'right-operand-not-imported-factory',
      detail: 'no ?? right operand resolves to the imported createProvider factory binding',
    };
  }
  return {
    ok: false,
    failure: 'no-nullish-declaration',
    detail: 'no nullish-coalescing provider-factory binding found',
  };
}

/**
 * Identify the `createTransport` callback of root 1 by AST structure and binding
 * resolution (§9.5.3.3b). Returns undefined when identification is ambiguous, so
 * callers fail closed rather than choosing a candidate.
 */
export function identifyCallback(
  workspace: ScanWorkspace,
  options: ScanOptions = {},
): CallbackUnit | undefined {
  const opt = resolveOptions(options);
  const abs = path.join(workspace.rootDir, opt.runtimeModule);
  const sf = workspace.program.getSourceFile(abs);
  if (sf === undefined) return undefined;
  const checker = workspace.checker;

  // Step 1: resolve the `providerFactory` binding through the TypeChecker.
  const resolution = resolveProviderFactory(workspace, options);
  if (!resolution.ok || resolution.bindingName === undefined) return undefined;
  const factoryName = resolution.bindingName;

  // Step 2: enumerate every call whose callee resolves to that binding.
  const invocations = findCallExpressions(
    sf,
    (call) => ts.isIdentifier(call.expression) && call.expression.text === factoryName,
  );
  if (invocations.length !== 1) return undefined;

  // Step 3: second argument must be an object literal with exactly one
  // `createTransport` property.
  const call = invocations[0];
  if (call === undefined) return undefined;
  const arg = call.arguments[1];
  if (arg === undefined || !ts.isObjectLiteralExpression(arg)) return undefined;
  const props = arg.properties.filter(
    (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'createTransport',
  );
  if (props.length !== 1) return undefined;
  const prop = props[0];
  if (prop === undefined || !ts.isPropertyAssignment(prop)) return undefined;

  // Step 4/5: the value must resolve to a single function expression.
  const fn = functionExpressionOf(checker, prop.initializer);
  if (fn === undefined) return undefined;

  const loc = sourceLocation(sf, fn.getStart(sf));

  // The callback's literal dynamic-import target, if any.
  let dynamicImportTarget: string | undefined;
  const walkBody = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const resolved = resolveSpecifier(workspace, node.arguments[0].text, sf.fileName);
      if (resolved !== undefined && !resolved.isBare) dynamicImportTarget = resolved.target;
    }
    ts.forEachChild(node, walkBody);
  };
  walkBody(fn.body);

  const base: CallbackUnit = {
    origin: `${opt.runtimeModule}#createTransport@${loc}`,
    node: fn,
    sourceFile: sf,
  };
  return dynamicImportTarget === undefined ? base : { ...base, dynamicImportTarget };
}

/**
 * Resolve the modules supplying imported bindings the callback references
 * (obligation C2). A local `const` referenced by the body is **not** expanded
 * into its initialiser — that boundary is what keeps `env.ts` out (§9.5.3.3b).
 */
export function callbackReferenceModules(
  workspace: ScanWorkspace,
  unit: CallbackUnit,
): Set<string> {
  const checker = workspace.checker;
  const out = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isVariableDeclaration(parent) && parent.name === node) ||
        (ts.isParameter(parent) && parent.name === node) ||
        (ts.isFunctionDeclaration(parent) && parent.name === node);
      if (!isName) {
        const sym = checker.getSymbolAtLocation(node);
        for (const decl of sym?.getDeclarations() ?? []) {
          if (ts.isImportSpecifier(decl) || ts.isImportClause(decl) || ts.isNamespaceImport(decl)) {
            let declNode: ts.Node = decl;
            while (declNode !== undefined && !ts.isImportDeclaration(declNode)) {
              const next: ts.Node | undefined = declNode.parent;
              if (next === undefined) break;
              declNode = next;
            }
            if (ts.isImportDeclaration(declNode)) {
              const spec = declNode.moduleSpecifier;
              if (ts.isStringLiteral(spec)) {
                const resolved = resolveSpecifier(workspace, spec.text, unit.sourceFile.fileName);
                if (resolved !== undefined && !resolved.isBare) out.add(resolved.target);
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(unit.node.body);
  return out;
}

// ---------------------------------------------------------------------------
// Exclusion classification (§11.5.4 B, stage two)
// ---------------------------------------------------------------------------

/**
 * Assign exactly one reason to an edge stage one has excluded. The order is
 * normative and first-match wins; `not-transport-wiring` is the residual member
 * and applies only when no earlier row matched. Classification never influences
 * traversal.
 */
export function classifyExclusion(edge: {
  readonly edgeKind: EdgeKind;
  readonly isBare: boolean;
  readonly target: string;
}): ExclusionReason {
  if (edge.edgeKind === 'type-only') return 'type-only';
  if (edge.isBare) return 'bare-specifier';
  const t = edge.target;
  if (t === 'src/app.ts' || t.startsWith('src/routes/') || t.startsWith('src/core/http/')) {
    return 'http-composition';
  }
  if (t.startsWith('src/core/persistence/') || t.includes('/repository/')) return 'persistence';
  if (t.startsWith('src/modules/health/')) return 'health-and-probes';
  if (t.startsWith('src/core/lifecycle/')) return 'lifecycle';
  return 'not-transport-wiring';
}

// ---------------------------------------------------------------------------
// Part B
// ---------------------------------------------------------------------------

/** Result of the part B analysis. */
export interface PartBReport extends ScanReport {
  readonly callback: CallbackUnit | undefined;
  readonly exclusions: readonly ExclusionRecord[];
}

/** Walk the bounded production wiring closure (§9.5.3.3a). */
export function scanPartB(
  workspace: ScanWorkspace = createRepoWorkspace(),
  options: ScanOptions = {},
): PartBReport {
  const opt = resolveOptions(options);
  const failures: string[] = [];
  const edges: ScanEdge[] = [];
  const modules: string[] = [];

  const callback = identifyCallback(workspace, options);
  const referenced = callback === undefined ? new Set<string>() : callbackReferenceModules(workspace, callback);

  const analysed = new Set<string>();
  // Modules whose value-level edges carry provider, transport or configuration
  // wiring. Seeded with the wiring origins and grown monotonically, so the
  // closure is a fixpoint and participation never depends on visit order.
  const wiringModules = new Set<string>(opt.wiringOrigins);
  const queue: string[] = [...opt.roots];

  const participates = (origin: string, raw: RawEdge): boolean => {
    if (raw.edgeKind === 'type-only') return false;
    if (raw.resolved.isBare) return false;
    const target = raw.resolved.target;
    if (opt.roots.includes(target)) return true;
    if (callback?.dynamicImportTarget !== undefined && target === callback.dynamicImportTarget) {
      return true;
    }
    if (referenced.has(target)) return true;
    if (wiringModules.has(origin)) return true;
    if (wiringModules.has(target)) return true;
    return false;
  };

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    if (analysed.has(current)) continue;
    analysed.add(current);
    modules.push(current);

    const abs = path.join(workspace.rootDir, current);
    const sf = workspace.program.getSourceFile(abs);
    if (sf === undefined) {
      failures.push(`unresolved module in part B closure: ${current}`);
      continue;
    }

    for (const raw of collectEdges(workspace, sf, current)) {
      const base = {
        origin: raw.origin,
        edgeKind: raw.edgeKind,
        sourceLocation: raw.sourceLocation,
        target: raw.resolved.target,
      } as const;

      if (raw.edgeKind === 'dynamic-import' && raw.resolved.target === '<computed>') {
        edges.push({ ...base, disposition: 'excluded', reason: 'not-transport-wiring' });
        failures.push(
          `computed dynamic-import specifier at ${current}:${raw.sourceLocation} (rule B5)`,
        );
        continue;
      }

      if (participates(current, raw)) {
        edges.push({ ...base, disposition: 'followed' });
        // The target is now in the wiring closure: its own value-level edges are
        // wiring too, which is what makes transitive expansion a fixpoint.
        if (!raw.resolved.isBare) wiringModules.add(raw.resolved.target);
        if (!analysed.has(raw.resolved.target)) queue.push(raw.resolved.target);
      } else {
        const reason = classifyExclusion({
          edgeKind: raw.edgeKind,
          isBare: raw.resolved.isBare,
          target: raw.resolved.target,
        });
        edges.push({ ...base, disposition: 'excluded', reason });
      }
    }
  }

  // Fail closed on a helper the callback invokes whose definition cannot be
  // located (§9.5.3.3b: "an unresolvable callback call ... is a failure").
  if (callback !== undefined) {
    const checker = workspace.checker;
    const walkCalls = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        const sym = checker.getSymbolAtLocation(node.expression);
        if (sym === undefined || (sym.getDeclarations() ?? []).length === 0) {
          failures.push(
            `unresolved callback helper '${name}' at ${callback.sourceFile.fileName}:${sourceLocation(
              callback.sourceFile,
              node.getStart(callback.sourceFile),
            )}`,
          );
        }
      }
      ts.forEachChild(node, walkCalls);
    };
    walkCalls(callback.node.body);
  }

  // Fail closed on a local module specifier that cannot be resolved.
  for (const mod of [...analysed]) {
    const sf = workspace.program.getSourceFile(path.join(workspace.rootDir, mod));
    if (sf === undefined) continue;
    const walkSpecs = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const spec = node.moduleSpecifier.text;
        if (isRelativeSpecifier(spec) && resolveSpecifier(workspace, spec, sf.fileName) === undefined) {
          failures.push(
            `unresolved local specifier '${spec}' from ${mod}:${sourceLocation(sf, node.moduleSpecifier.getStart(sf))}`,
          );
        }
      }
      ts.forEachChild(node, walkSpecs);
    };
    walkSpecs(sf);
  }

  // Callback reference edges: provenance, distinct origin (§9.5.3.3b).
  if (callback !== undefined) {
    for (const mod of referenced) {
      edges.push({
        origin: callback.origin,
        edgeKind: 'static-import',
        sourceLocation: sourceLocation(callback.sourceFile, callback.node.getStart(callback.sourceFile)),
        target: mod,
        disposition: 'followed',
      });
    }
  }

  const deduped = dedupeEdges(edges);
  const exclusions: ExclusionRecord[] = deduped
    .filter((e) => e.disposition === 'excluded' && e.reason !== undefined)
    .map((e) => ({
      origin: e.origin,
      edgeKind: e.edgeKind,
      sourceLocation: e.sourceLocation,
      target: e.target,
      reason: e.reason as ExclusionReason,
    }));

  return { part: 'B', edges: deduped, modules, failures, callback, exclusions };
}

/** True when `src/runtime.ts` has no static import of the transport module (condition 12). */
export function runtimeHasNoStaticTransportImport(
  workspace: ScanWorkspace = createRepoWorkspace(),
  options: ScanOptions = {},
): boolean {
  const opt = resolveOptions(options);
  const sf = workspace.program.getSourceFile(path.join(workspace.rootDir, opt.runtimeModule));
  if (sf === undefined) return false;
  const edges = collectEdges(workspace, sf, opt.runtimeModule);
  return !edges.some(
    (e) =>
      e.resolved.target === opt.transportBoundary &&
      e.edgeKind !== 'type-only' &&
      e.edgeKind !== 'dynamic-import',
  );
}

/**
 * True when `node` resolves to the `createGeminiTransport` export of the
 * designated transport module (§9.5.3.3b). The production binding is reached
 * two ways: a static import specifier, or a destructuring of a literal
 * `await import()` — both must resolve to the same declaration.
 */
function resolvesToTransportFactory(
  workspace: ScanWorkspace,
  node: ts.Expression,
  transportSf: ts.SourceFile,
  transportBoundary: string,
): boolean {
  const checker = workspace.checker;
  const decl = checker.getSymbolAtLocation(node)?.getDeclarations()?.[0];

  const isFactoryDecl = (d: ts.Declaration | undefined): boolean =>
    d !== undefined &&
    ts.isFunctionDeclaration(d) &&
    d.name?.text === 'createGeminiTransport' &&
    d.getSourceFile() === transportSf;

  if (isFactoryDecl(decl)) return true;

  if (decl !== undefined && ts.isImportSpecifier(decl)) {
    const sym = checker.getSymbolAtLocation(decl.name);
    if (sym !== undefined && (sym.flags & ts.SymbolFlags.Alias) !== 0) {
      return isFactoryDecl(checker.getAliasedSymbol(sym).getDeclarations()?.[0]);
    }
  }

  // `const { createGeminiTransport } = await import('…gemini.transport.js')`
  if (decl !== undefined && ts.isBindingElement(decl)) {
    const pattern = decl.parent;
    const varDecl = pattern.parent;
    if (!ts.isObjectBindingPattern(pattern) || !ts.isVariableDeclaration(varDecl)) return false;
    const init = varDecl.initializer;
    if (init === undefined || !ts.isAwaitExpression(init) || init.expression === undefined) return false;
    const call = init.expression;
    if (!ts.isCallExpression(call) || call.expression.kind !== ts.SyntaxKind.ImportKeyword) return false;
    const spec = call.arguments[0];
    if (spec === undefined || !ts.isStringLiteral(spec)) return false;
    const resolved = resolveSpecifier(workspace, spec.text, varDecl.getSourceFile().fileName);
    if (resolved === undefined || resolved.isBare) return false;
    if (resolved.target !== transportBoundary) return false;
    const boundName = decl.propertyName ?? decl.name;
    return ts.isIdentifier(boundName) && boundName.text === 'createGeminiTransport';
  }

  return false;
}

/** Count call expressions resolving to `createGeminiTransport` (§9.5.3.3b condition 11). */
export function countTransportConstructionSites(
  workspace: ScanWorkspace = createRepoWorkspace(),
  options: ScanOptions = {},
): number {
  const opt = resolveOptions(options);
  const transportSf = workspace.program.getSourceFile(
    path.join(workspace.rootDir, opt.transportBoundary),
  );
  if (transportSf === undefined) return 0;

  let count = 0;
  const roots = [...opt.roots, opt.adapterEntry];
  for (const rel of roots) {
    const sf = workspace.program.getSourceFile(path.join(workspace.rootDir, rel));
    if (sf === undefined) continue;
    for (const call of findCallExpressions(sf, () => true)) {
      if (resolvesToTransportFactory(workspace, call.expression, transportSf, opt.transportBoundary)) {
        count += 1;
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Allow-list enforcement (§9.5.3.5a)
// ---------------------------------------------------------------------------

/** One allow-list entry shape the enforcement accepts (avoids an import cycle). */
export interface AllowlistLike {
  readonly specifier: string;
  readonly part: 'A' | 'B';
  readonly origin: string;
  readonly kind: EdgeKind;
  readonly reason: string;
}

/**
 * Enforce the closed allow-list in both directions (§9.5.3.5a).
 *
 * - An unlisted bare specifier on a non-type-only edge from an analysed module is
 *   a failure (rule B6). A specifier occurring only on `type-only` edges is exempt
 *   (rule B6a) and is never required to be listed.
 * - An entry whose specifier no longer appears on a matching edge is a stale entry
 *   and is also a failure, so a removed dependency cannot linger.
 */
export function checkAllowlist(
  report: ScanReport,
  entries: readonly AllowlistLike[],
): { readonly failures: readonly string[] } {
  const failures: string[] = [];
  const partEntries = entries.filter((e) => e.part === report.part);

  for (const edge of report.edges) {
    if (edge.target.startsWith('src/')) continue;
    if (edge.target === '<computed>') continue;
    if (edge.edgeKind === 'type-only') continue; // B6a: exempt, not listed
    const listed = partEntries.some(
      (e) => e.specifier === edge.target && e.origin === edge.origin && e.kind === edge.edgeKind,
    );
    if (!listed) {
      failures.push(
        `unlisted bare specifier '${edge.target}' on ${edge.edgeKind} edge from ${edge.origin} (${edge.sourceLocation})`,
      );
    }
  }

  for (const entry of partEntries) {
    const reached = report.edges.some(
      (e) =>
        e.target === entry.specifier &&
        e.origin === entry.origin &&
        e.edgeKind === entry.kind,
    );
    if (!reached) {
      failures.push(
        `stale allow-list entry: '${entry.specifier}' (${entry.kind}) from ${entry.origin} no longer appears`,
      );
    }
  }

  return { failures };
}

// ---------------------------------------------------------------------------
// Five-stage value trace (§9.5.3.3a)
// ---------------------------------------------------------------------------

/** One resolved stage of the trace. */
export interface TraceStage {
  readonly name: string;
  readonly resolved: boolean;
  readonly detail: string;
}

/** Result of the end-to-end value trace. */
export interface TraceResult {
  readonly ok: boolean;
  readonly stages: readonly TraceStage[];
  readonly failures: readonly string[];
  /** Stage 4's awaited transport binding name, when resolved. */
  readonly transportBinding?: string;
  /** The callback unit origin, when identified. */
  readonly callbackOrigin?: string;
}

/**
 * Strip parentheses and non-null assertions. `deps.createTransport!()` and
 * `(deps.createTransport)()` are the same callee as `deps.createTransport()`.
 */
function unwrapExpression(node: ts.Expression): ts.Expression {
  let cur = node;
  while (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur)) {
    cur = cur.expression;
  }
  return cur;
}

/**
 * Resolve an identifier to the Stage 4 transport binding, following direct
 * aliases of the form `const t = transport` (§9.5.3.3a identity table:
 * "Preserved — direct alias of the same binding, with no intervening write").
 * A chain that leaves the single-function-body form is not followed.
 */
function resolveAliasToBinding(
  checker: ts.TypeChecker,
  node: ts.Expression,
  transportBinding: string | undefined,
): boolean {
  if (transportBinding === undefined) return false;
  let cur = unwrapExpression(node);
  const seen = new Set<string>();
  for (;;) {
    if (!ts.isIdentifier(cur)) return false;
    if (cur.text === transportBinding) return true;
    if (seen.has(cur.text)) return false;
    seen.add(cur.text);
    // Resolve the *reference* to its declaration through the symbol table; the
    // usage site's parent is the property assignment, not the declaration.
    const decls = checker.getSymbolAtLocation(cur)?.getDeclarations() ?? [];
    if (decls.length !== 1) return false;
    const decl = decls[0];
    if (decl === undefined || !ts.isVariableDeclaration(decl) || decl.initializer === undefined) {
      return false;
    }
    // A conditional or reassigned declaration does not preserve identity.
    const list = decl.parent;
    if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) {
      return false;
    }
    cur = unwrapExpression(decl.initializer);
  }
}

/** Run the five-stage end-to-end value trace as a single chain. */
export function runValueTrace(
  workspace: ScanWorkspace = createRepoWorkspace(),
  options: ScanOptions = {},
): TraceResult {
  const opt = resolveOptions(options);
  const stages: TraceStage[] = [];
  const failures: string[] = [];
  const checker = workspace.checker;
  const get = (rel: string): ts.SourceFile | undefined =>
    workspace.program.getSourceFile(path.join(workspace.rootDir, rel));

  // --- Stage 1: production call-site evidence -----------------------------
  const indexSf = get(opt.entryPoint);
  const runtimeSf = get(opt.runtimeModule);
  let stage1 = false;
  let stage1Detail = 'unresolved';
  if (indexSf !== undefined && runtimeSf !== undefined) {
    const calls = findCallExpressions(
      indexSf,
      (c) => ts.isIdentifier(c.expression) && c.expression.text === 'createRuntime',
    );
    if (calls.length === 1) {
      const call = calls[0];
      if (call !== undefined && call.arguments.length === 0) {
        const runtimeDecl = runtimeSf.statements.find(
          (s): s is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(s) && s.name?.text === 'createRuntime',
        );
        const param = runtimeDecl?.parameters[0];
        const hasDefault =
          param !== undefined &&
          param.initializer !== undefined &&
          ts.isObjectLiteralExpression(param.initializer) &&
          param.initializer.properties.length === 0;
        if (hasDefault) {
          stage1 = true;
          stage1Detail = 'createRuntime() with zero arguments; default {} established';
        } else {
          failures.push('Stage 1: createRuntime default parameter is not an empty object literal');
        }
      } else {
        failures.push('Stage 1: production call site passes arguments or cannot be determined');
      }
    } else {
      failures.push(`Stage 1: expected exactly one createRuntime call site, found ${calls.length}`);
    }
  } else {
    failures.push('Stage 1: entry point or runtime module missing');
  }
  stages.push({ name: 'stage1', resolved: stage1, detail: stage1Detail });

  // --- Stage 2: factory invocation through the local binding --------------
  let stage2 = false;
  let callbackUnit: CallbackUnit | undefined;
  if (runtimeSf !== undefined) {
    callbackUnit = identifyCallback(workspace, options);
    stage2 = callbackUnit !== undefined;
    if (!stage2) {
      const resolution = resolveProviderFactory(workspace, options);
      failures.push(`Stage 2: callback pairing is ambiguous or unresolvable (${resolution.detail})`);
    }
  } else {
    failures.push('Stage 2: runtime module missing');
  }
  stages.push({
    name: 'stage2',
    resolved: stage2,
    detail: callbackUnit === undefined ? 'unresolved' : callbackUnit.origin,
  });

  // --- Stage 3: callback execution path -----------------------------------
  let stage3 = false;
  if (callbackUnit !== undefined) {
    stage3 = callbackUnit.dynamicImportTarget !== undefined;
    if (!stage3) failures.push('Stage 3: callback has no literal dynamic-import target');
  } else {
    failures.push('Stage 3: no callback unit');
  }
  stages.push({
    name: 'stage3',
    resolved: stage3,
    detail: callbackUnit?.dynamicImportTarget ?? 'unresolved',
  });

  // --- Stage 4: factory consumption ---------------------------------------
  const factorySf = get(opt.factoryModule);
  let stage4 = false;
  let transportBinding: string | undefined;
  if (factorySf !== undefined) {
    const invocations = findCallExpressions(factorySf, (c) => {
      const e = unwrapExpression(c.expression);
      return (
        ts.isPropertyAccessExpression(e) &&
        ts.isIdentifier(e.expression) &&
        e.name.text === 'createTransport'
      );
    });
    if (invocations.length === 1) {
      const inv = invocations[0];
      if (inv !== undefined && inv.parent !== undefined && ts.isAwaitExpression(inv.parent)) {
        const decl = inv.parent.parent;
        if (decl !== undefined && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
          stage4 = true;
          transportBinding = decl.name.text;
        }
      }
      if (!stage4) failures.push('Stage 4: awaited createTransport result is not bound to an identifier');
    } else {
      failures.push(`Stage 4: expected exactly one deps.createTransport() call, found ${invocations.length}`);
    }
  } else {
    failures.push('Stage 4: factory module missing');
  }
  stages.push({
    name: 'stage4',
    resolved: stage4,
    detail: transportBinding ?? 'unresolved',
  });

  // --- Stage 5: provider injection ----------------------------------------
  let stage5 = false;
  if (factorySf !== undefined) {
    let found = false;
    const walk = (node: ts.Node): void => {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'GeminiProvider'
      ) {
        const arg = node.arguments?.[1];
        if (arg !== undefined && ts.isObjectLiteralExpression(arg)) {
          for (const prop of arg.properties) {
            // `{ transport }` shorthand and `{ transport: transport }` both
            // preserve identity (§9.5.3.3a identity table).
            if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'transport') {
              found = transportBinding !== undefined;
            } else if (
              ts.isPropertyAssignment(prop) &&
              ts.isIdentifier(prop.name) &&
              prop.name.text === 'transport'
            ) {
              found = resolveAliasToBinding(checker, prop.initializer, transportBinding);
            }
          }
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(factorySf);
    stage5 = found;
    if (!stage5) failures.push('Stage 5: injected transport is not the Stage 4 binding');
  } else {
    failures.push('Stage 5: factory module missing');
  }
  stages.push({
    name: 'stage5',
    resolved: stage5,
    detail: stage5 ? 'identity preserved' : 'unresolved',
  });

  const ok = stages.every((s) => s.resolved);
  const result: TraceResult = { ok, stages, failures };
  return transportBinding === undefined && callbackUnit === undefined
    ? result
    : {
        ...result,
        ...(transportBinding === undefined ? {} : { transportBinding }),
        ...(callbackUnit === undefined ? {} : { callbackOrigin: callbackUnit.origin }),
      };
}
