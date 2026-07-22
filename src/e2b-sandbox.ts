import { createHash } from 'node:crypto';
import type {
  HarnessV1NetworkSandboxSession,
  HarnessV1SandboxProvider,
} from '@ai-sdk/harness';
import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';
import { ConnectionConfig, Sandbox } from 'e2b';
import type { SandboxOpts } from 'e2b';
import packageJson from '../package.json' with { type: 'json' };
import { E2BNetworkSandboxSession } from './e2b-network-sandbox-session';
import { E2BSandboxSession } from './e2b-sandbox-session';
import { withAbort } from './utils';

/**
 * Identify traffic from this provider to E2B for usage attribution. E2B appends
 * this token to the `User-Agent` of every request (an explicit caller
 * `User-Agent` still wins). The version is derived from `package.json` rather
 * than hardcoded so it tracks releases automatically. The slug mirrors E2B's
 * own de-scoped convention (`@e2b/code-interpreter` → `e2b-code-interpreter`).
 *
 * Set once at module load, before any `ConnectionConfig` is constructed —
 * configs read the value at construction time.
 */
ConnectionConfig.setIntegration(`e2b-ai-sdk-sandbox/${packageJson.version}`);

type OnFirstCreate = (
  session: SandboxSession,
  opts: { abortSignal?: AbortSignal },
) => Promise<void>;

/**
 * Settings for {@link createE2BSandbox}. Two mutually-exclusive shapes:
 *
 * - `{ sandbox }` — wrap an already-created E2B `Sandbox`. The caller owns its
 *   lifecycle; the provider's `stop()` and `destroy()` are no-ops. Optionally
 *   declare `bridgePorts` to give the harness a port pool to lease from for
 *   concurrent sessions on the same provided sandbox.
 * - E2B [`SandboxOpts`](https://e2b.dev/docs) fields (`template`, `envs`,
 *   `timeoutMs`, `metadata`, `allowInternetAccess`, `network`, …) — the
 *   provider creates the underlying sandbox per session. When a `sessionId` is
 *   supplied it is tagged in the sandbox metadata so `resumeSession` can
 *   reconnect to it later.
 */
export type E2BSandboxSettings =
  | {
      sandbox: Sandbox;
      bridgePorts?: ReadonlyArray<number>;
    }
  | (SandboxOpts & {
      sandbox?: never;
      /**
       * Ports advertised on `session.ports` (the bridge adapter binds to
       * `ports[0]`). E2B reaches any listening port via `getHost`, so this is
       * just the advertised set.
       */
      ports?: ReadonlyArray<number>;
      /**
       * Shell commands run once on a fresh sandbox, after create and BEFORE
       * `onFirstCreate` (i.e. before a harness adapter's bootstrap). Use this to
       * provision tools the adapter expects but the template lacks — e.g. the
       * claude-code adapter needs `pnpm`:
       *
       * ```ts
       * setupCommands: ['sudo npm install -g pnpm@9']
       * ```
       *
       * For production, prefer baking these into a custom E2B template.
       */
      setupCommands?: ReadonlyArray<string>;
    });

/**
 * 30 minutes. The E2B SDK defaults to 5 minutes, which is too short for
 * multi-step agent workflows — the sandbox expires between steps.
 */
const DEFAULT_SANDBOX_TIMEOUT_MS = 30 * 60 * 1_000;

const E2B_PROVIDER_ID = 'e2b-sandbox';

/**
 * Metadata key under which a session id is tagged at create time. E2B sandbox
 * ids are server-assigned, so `resumeSession` finds the sandbox by this tag
 * rather than by a deterministic name.
 *
 * Isolation note: `resumeSession` matches on this tag scoped to the provider's
 * connection (`apiKey`/`domain`), so a sandbox can only ever be resumed from
 * the same E2B account it was created on. The trust boundary is therefore the
 * E2B API key. See the `resumeSession` doc for the multi-tenancy contract.
 */
const SESSION_METADATA_KEY = 'aiSdkSessionId';

/**
 * Metadata key under which the harness `identity` is tagged at create time
 * (when supplied). Recorded for ownership/auditing and to scope cleanup; the
 * harness `resumeSession` contract carries only `sessionId`, so the provider
 * cannot filter resume by identity at resume time.
 */
const IDENTITY_METADATA_KEY = 'aiSdkIdentity';

const DEFAULT_WORKING_DIRECTORY = '/home/user';

const SNAPSHOT_NAME_PREFIX = 'ai-sdk-harness';
const SNAPSHOT_CACHE_KEY = Symbol.for('ai-sdk.harness.e2b-snapshot-names');
type SnapshotNameCache = Map<string, Promise<string>>;

/**
 * In-process cache of in-flight/resolved snapshot builds, keyed by snapshot
 * name. Dedups concurrent builds within a process; the durable, cross-process
 * reuse comes from the named snapshot itself (found via `listSnapshots`).
 */
function getSnapshotCache(): SnapshotNameCache {
  const globals = globalThis as { [SNAPSHOT_CACHE_KEY]?: SnapshotNameCache };
  return (globals[SNAPSHOT_CACHE_KEY] ??= new Map());
}

/** Deterministic, E2B-safe snapshot name for a harness identity. (Exported for tests.) */
export function snapshotName(identity: string): string {
  const slug = identity
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 12);
  return `${SNAPSHOT_NAME_PREFIX}-${slug}-${hash}`;
}

/**
 * Strip the team namespace and tag from a snapshot ref to its bare name.
 * E2B returns names like `team-slug/ai-sdk-harness-x` and ids like
 * `team-slug/ai-sdk-harness-x:default`.
 */
function snapshotBaseName(ref: string): string {
  return (ref.split('/').pop() ?? ref).replace(/:[^/:]+$/, '');
}

function isWrapSettings(
  settings: E2BSandboxSettings,
): settings is { sandbox: Sandbox; bridgePorts?: ReadonlyArray<number> } {
  return 'sandbox' in settings && settings.sandbox != null;
}

/** Read the live sandbox's working directory (provider-configurable). */
async function resolveWorkingDirectory(
  sandbox: Sandbox,
  abortSignal?: AbortSignal,
): Promise<string> {
  try {
    const { stdout } = await sandbox.commands.run('pwd', {
      ...(abortSignal ? { signal: abortSignal } : {}),
    });
    const dir = stdout.trim();
    return dir.length > 0 ? dir : DEFAULT_WORKING_DIRECTORY;
  } catch {
    // Don't swallow an abort into a successful default.
    abortSignal?.throwIfAborted();
    return DEFAULT_WORKING_DIRECTORY;
  }
}

export function createE2BSandbox(
  settings: E2BSandboxSettings = {} as E2BSandboxSettings,
): HarnessV1SandboxProvider {
  return new E2BSandboxProvider(settings);
}

/**
 * `HarnessV1SandboxProvider` implementation backed by E2B Sandboxes. Construct
 * one via {@link createE2BSandbox} at module scope and pass it to a
 * `HarnessAgent` (or call `createSession()` directly for raw access to a
 * network sandbox session). The constructor performs no I/O; the sandbox is
 * created (or connected) when `createSession()` / `resumeSession()` is called.
 */
export class E2BSandboxProvider implements HarnessV1SandboxProvider {
  readonly specificationVersion = 'harness-sandbox-v1' as const;
  readonly providerId = E2B_PROVIDER_ID;
  readonly bridgePorts?: ReadonlyArray<number>;

  constructor(private readonly settings: E2BSandboxSettings) {
    if (
      isWrapSettings(settings) &&
      settings.bridgePorts != null &&
      settings.bridgePorts.length > 0
    ) {
      this.bridgePorts = [...settings.bridgePorts];
    }
  }

  private get advertisedPorts(): ReadonlyArray<number> {
    if (isWrapSettings(this.settings)) return this.settings.bridgePorts ?? [];
    return this.settings.ports ?? [];
  }

  /**
   * Connection-level settings (api key, domain, headers, …) reused when
   * `resumeSession` lists/connects, so resume hits the same account/env the
   * sandbox was created on rather than falling back to environment defaults.
   */
  private connectionOptions() {
    if (isWrapSettings(this.settings)) return {};
    const { apiKey, headers, apiHeaders, debug, domain, requestTimeoutMs } =
      this.settings;
    return { apiKey, headers, apiHeaders, debug, domain, requestTimeoutMs };
  }

  /** E2B create params from settings, stripped of provider-level keys. */
  private createParams(sessionId?: string, identity?: string): SandboxOpts {
    if (isWrapSettings(this.settings)) return {};
    const {
      ports: _ports,
      setupCommands: _setupCommands,
      metadata,
      timeoutMs,
      ...rest
    } = this.settings;
    return {
      ...rest,
      timeoutMs: timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
      metadata: {
        ...metadata,
        ...(sessionId ? { [SESSION_METADATA_KEY]: sessionId } : {}),
        ...(identity ? { [IDENTITY_METADATA_KEY]: identity } : {}),
      },
    };
  }

  /** setupCommands for create-new mode (empty when wrapping a sandbox). */
  private get setupCommands(): ReadonlyArray<string> {
    return isWrapSettings(this.settings) ? [] : this.settings.setupCommands ?? [];
  }

  /**
   * Per-identity snapshot reuse. Builds the recipe's snapshot once (running
   * setupCommands + onFirstCreate, then `createSnapshot`), and returns a
   * forkable snapshot name. The in-process cache dedups concurrent builds; the
   * snapshot itself survives cold starts and is found via `listSnapshots`, so
   * later sessions (even in other processes) fork from it instead of rebuilding.
   */
  private getOrCreateSnapshot(
    identity: string,
    onFirstCreate: OnFirstCreate,
  ): Promise<string> {
    const name = snapshotName(identity);
    const cache = getSnapshotCache();
    let pending = cache.get(name);
    if (pending == null) {
      // The build is shared across all callers for this identity, so it is not
      // tied to any single caller's abort signal — one caller aborting must not
      // cancel a build others are awaiting. Callers abort their own *wait* via
      // `withAbort` at the call site. (Cross-process, two cold builds can race;
      // both attach to the same snapshot name and are usable — one is wasted.)
      pending = (async () => {
        if (!(await this.snapshotExists(name))) {
          await this.buildSnapshot(name, onFirstCreate);
        }
        return name;
      })();
      cache.set(name, pending);
      pending.catch(() => cache.delete(name));
    }
    return pending;
  }

  /** Whether a snapshot with this bare name already exists (any process). */
  private async snapshotExists(name: string): Promise<boolean> {
    const conn = this.connectionOptions();
    // The `name` filter (e2b 2.34+) narrows the lookup server-side, so a single
    // page replaces the old scan across every team snapshot. The paginator
    // already carries `conn`, so `nextItems()` needs no arguments. Still confirm
    // an exact base-name match: the filter also matches ids and tag-qualified
    // refs rather than only the bare name.
    const items = await Sandbox.listSnapshots({ ...conn, name }).nextItems();
    return items.some(
      info =>
        info.names?.some(n => snapshotBaseName(n) === name) ||
        snapshotBaseName(info.snapshotId) === name,
    );
  }

  /**
   * Build the named snapshot: run setup + onFirstCreate on a throwaway sandbox,
   * snapshot it, then kill it. The template sandbox is never tagged with a
   * session id, so it can't be resumed by mistake. Runs without a caller abort
   * signal — it's shared work (see `getOrCreateSnapshot`).
   */
  private async buildSnapshot(
    name: string,
    onFirstCreate: OnFirstCreate,
  ): Promise<void> {
    const sandbox = await Sandbox.create(this.createParams(undefined));
    try {
      const restricted = new E2BSandboxSession(sandbox);
      for (const command of this.setupCommands) {
        const result = await restricted.run({ command });
        if (result.exitCode !== 0) {
          throw new Error(
            `E2B setupCommand failed (exit ${result.exitCode}): ${command}\n${result.stderr}`,
          );
        }
      }
      await onFirstCreate(restricted, {});
      await sandbox.createSnapshot({ name, ...this.connectionOptions() });
    } finally {
      // Best-effort cleanup; never block on a stuck kill during teardown.
      await sandbox.kill().catch(() => {});
    }
  }

  createSession = async (options?: {
    sessionId?: string;
    abortSignal?: AbortSignal;
    identity?: string;
    onFirstCreate?: (
      session: SandboxSession,
      opts: { abortSignal?: AbortSignal },
    ) => Promise<void>;
  }): Promise<HarnessV1NetworkSandboxSession> => {
    options?.abortSignal?.throwIfAborted();

    // Wrap-existing mode: reuse the caller's sandbox, no lifecycle ownership.
    if (isWrapSettings(this.settings)) {
      const sandbox = this.settings.sandbox;
      const workingDirectory = await resolveWorkingDirectory(
        sandbox,
        options?.abortSignal,
      );
      return new E2BNetworkSandboxSession({
        sandbox,
        workingDirectory,
        ports: this.settings.bridgePorts,
        ownsLifecycle: false,
      });
    }

    // Per-identity reuse: build the recipe's snapshot once, then fork each
    // session from it (the hook does not re-run on forks).
    if (options?.identity != null && options?.onFirstCreate != null) {
      const snapshotRef = await withAbort(
        this.getOrCreateSnapshot(options.identity, options.onFirstCreate),
        options.abortSignal,
      );
      // The snapshot ref is the template arg, so drop `template` from the opts.
      const { template: _template, ...forkParams } = this.createParams(
        options.sessionId,
        options.identity,
      );
      const fork = await Sandbox.create(snapshotRef, {
        ...forkParams,
        ...(options.abortSignal ? { signal: options.abortSignal } : {}),
      });
      try {
        const workingDirectory = await resolveWorkingDirectory(
          fork,
          options.abortSignal,
        );
        return new E2BNetworkSandboxSession({
          sandbox: fork,
          workingDirectory,
          ports: this.advertisedPorts,
          ownsLifecycle: true,
        });
      } catch (error) {
        await fork.kill().catch(() => {});
        throw error;
      }
    }

    const sandbox = await Sandbox.create({
      ...this.createParams(options?.sessionId, options?.identity),
      ...(options?.abortSignal ? { signal: options.abortSignal } : {}),
    });

    // If setup fails, don't orphan the freshly created (billable) sandbox.
    try {
      const workingDirectory = await resolveWorkingDirectory(
        sandbox,
        options?.abortSignal,
      );
      const restricted = new E2BSandboxSession(sandbox);

      // Provision adapter prerequisites (e.g. pnpm) before any bootstrap runs.
      for (const command of this.settings.setupCommands ?? []) {
        options?.abortSignal?.throwIfAborted();
        const result = await restricted.run({
          command,
          abortSignal: options?.abortSignal,
        });
        if (result.exitCode !== 0) {
          throw new Error(
            `E2B setupCommand failed (exit ${result.exitCode}): ${command}\n${result.stderr}`,
          );
        }
      }

      // No identity (or no onFirstCreate): fresh create, run the hook now.
      // (The identity + onFirstCreate path above handles snapshot reuse.)
      if (options?.onFirstCreate) {
        await options.onFirstCreate(restricted, {
          abortSignal: options.abortSignal,
        });
      }

      return new E2BNetworkSandboxSession({
        sandbox,
        workingDirectory,
        ports: this.advertisedPorts,
        ownsLifecycle: true,
      });
    } catch (error) {
      await sandbox.kill().catch(() => {});
      throw error;
    }
  };

  /**
   * Reattach to a sandbox created earlier with the same `sessionId`.
   *
   * Isolation: the harness `resumeSession` contract passes only `sessionId`
   * (no `identity`), so the lookup is by `sessionId` metadata scoped to this
   * provider's connection (`apiKey`/`domain`). Cross-account resume is thus
   * impossible. Within a single account, the trust boundary is the API key:
   * give each tenant its own provider (its own key). If one key is shared
   * across tenants, the framework-issued `sessionId`s must be unguessable, or a
   * caller who learns another tenant's `sessionId` could resume their sandbox.
   */
  resumeSession = async (options: {
    sessionId: string;
    abortSignal?: AbortSignal;
  }): Promise<HarnessV1NetworkSandboxSession> => {
    options.abortSignal?.throwIfAborted();

    // Wrap-existing case: caller owns the sandbox. Same session as createSession.
    if (isWrapSettings(this.settings)) {
      const sandbox = this.settings.sandbox;
      const workingDirectory = await resolveWorkingDirectory(
        sandbox,
        options.abortSignal,
      );
      return new E2BNetworkSandboxSession({
        sandbox,
        workingDirectory,
        ports: this.settings.bridgePorts,
        ownsLifecycle: false,
      });
    }

    // E2B sandbox ids are server-assigned, so look the sandbox up by the
    // session id we tagged in metadata at create time (works cross-process).
    // The paginator carries `conn`, so `nextItems` only needs the per-call signal.
    const conn = this.connectionOptions();
    const paginator = Sandbox.list({
      ...conn,
      query: {
        metadata: { [SESSION_METADATA_KEY]: options.sessionId },
        state: ['running', 'paused'],
      },
      limit: 1,
    });
    const [info] = await paginator.nextItems(
      options.abortSignal ? { signal: options.abortSignal } : undefined,
    );
    if (info == null) {
      throw new Error(
        `No resumable E2B sandbox found for session "${options.sessionId}".`,
      );
    }

    // connect() auto-resumes a paused sandbox.
    const sandbox = await Sandbox.connect(info.sandboxId, {
      ...conn,
      ...(options.abortSignal ? { signal: options.abortSignal } : {}),
    });
    const workingDirectory = await resolveWorkingDirectory(
      sandbox,
      options.abortSignal,
    );
    return new E2BNetworkSandboxSession({
      sandbox,
      workingDirectory,
      ports: this.advertisedPorts,
      ownsLifecycle: true,
    });
  };
}
