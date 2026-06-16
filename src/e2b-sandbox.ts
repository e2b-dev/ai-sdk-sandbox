import type {
  HarnessV1NetworkSandboxSession,
  HarnessV1SandboxProvider,
} from '@ai-sdk/harness';
import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';
import { Sandbox } from 'e2b';
import type { SandboxOpts } from 'e2b';
import { E2BNetworkSandboxSession } from './e2b-network-sandbox-session';
import { E2BSandboxSession } from './e2b-sandbox-session';

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
 */
const SESSION_METADATA_KEY = 'aiSdkSessionId';

const DEFAULT_WORKING_DIRECTORY = '/home/user';

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
      background: false,
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
  private createParams(sessionId?: string): SandboxOpts {
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
      },
    };
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

    const sandbox = await Sandbox.create({
      ...this.createParams(options?.sessionId),
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

      // No per-identity snapshot reuse: run the one-time setup immediately after
      // fresh create (spec-legal, like @ai-sdk/sandbox-just-bash). For cold-start
      // reuse, bake setup into a custom E2B template instead.
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
    const conn = this.connectionOptions();
    const [info] = await Sandbox.list({
      ...conn,
      query: {
        metadata: { [SESSION_METADATA_KEY]: options.sessionId },
        state: ['running', 'paused'],
      },
      limit: 1,
    }).nextItems(
      options.abortSignal ? { ...conn, signal: options.abortSignal } : conn,
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
