import {
  HarnessCapabilityUnsupportedError,
  type HarnessV1NetworkPolicy,
  type HarnessV1NetworkSandboxSession,
} from '@ai-sdk/harness';
import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';
import { ALL_TRAFFIC } from 'e2b';
import type { Sandbox, SandboxNetworkUpdate } from 'e2b';
import { E2BSandboxSession } from './e2b-sandbox-session';

const E2B_PROVIDER_ID = 'e2b-sandbox';

/**
 * `HarnessV1NetworkSandboxSession` backed by an E2B `Sandbox`. The provider's
 * `createSession()` returns one of these. It extends {@link E2BSandboxSession}
 * with the infra surface (ports, lifecycle, network policy). It owns the
 * sandbox's lifecycle only when the provider created it; when the provider was
 * given an existing sandbox, `stop()` and `destroy()` are no-ops (caller
 * retains ownership).
 *
 * Lifecycle maps to E2B's pause/kill model: `stop()` pauses the sandbox
 * (resumable via the provider's `resumeSession`), `destroy()` kills it.
 */
export class E2BNetworkSandboxSession
  extends E2BSandboxSession
  implements HarnessV1NetworkSandboxSession
{
  readonly id: string;
  readonly defaultWorkingDirectory: string;
  private exposedPorts: number[];
  private readonly ownsLifecycle: boolean;
  private stopped = false;
  private destroyed = false;

  constructor(input: {
    sandbox: Sandbox;
    workingDirectory: string;
    ports?: ReadonlyArray<number>;
    ownsLifecycle: boolean;
  }) {
    super(input.sandbox);
    this.id = input.sandbox.sandboxId;
    // E2B has no synchronous cwd accessor (unlike Vercel's
    // `sandbox.currentSession().cwd`), so the provider resolves it once via
    // `pwd` and passes it in for this spec-required property.
    this.defaultWorkingDirectory = input.workingDirectory;
    this.exposedPorts = [...(input.ports ?? [])];
    this.ownsLifecycle = input.ownsLifecycle;
  }

  get ports(): ReadonlyArray<number> {
    return this.exposedPorts;
  }

  restricted(): SandboxSession {
    return new E2BSandboxSession(this.sandbox);
  }

  getPortUrl = async (options: {
    port: number;
    protocol?: 'http' | 'https' | 'ws';
  }): Promise<string> => {
    // E2B exposes any listening port via getHost(); no pre-declaration needed.
    const host = this.sandbox.getHost(options.port);
    // E2B terminates TLS, so http→https and ws→wss.
    const protocol = options.protocol ?? 'https';
    const scheme = protocol === 'ws' ? 'wss' : 'https';
    return `${scheme}://${host}`;
  };

  setNetworkPolicy = async (policy: HarnessV1NetworkPolicy): Promise<void> => {
    await this.sandbox.updateNetwork(toE2BNetworkUpdate(policy));
  };

  // E2B reaches any listening port via getHost(), so "exposing" a port is just
  // advertising it on `ports`. Full-replacement semantics per the spec.
  setPorts = async (ports: ReadonlyArray<number>): Promise<void> => {
    this.exposedPorts = [...ports];
  };

  stop = async (): Promise<void> => {
    if (!this.ownsLifecycle || this.stopped || this.destroyed) return;
    // pause() keeps the filesystem + memory so resumeSession() can reattach.
    // Set the flag only after success so a transient failure stays retryable.
    await this.sandbox.pause();
    this.stopped = true;
  };

  destroy = async (): Promise<void> => {
    // Idempotent, and still kills a sandbox that was previously stopped/paused.
    if (!this.ownsLifecycle || this.destroyed) return;
    await this.sandbox.kill();
    this.destroyed = true;
  };
}

/** Map the harness network policy onto an E2B network update. */
export function toE2BNetworkUpdate(
  policy: HarnessV1NetworkPolicy,
): SandboxNetworkUpdate {
  switch (policy.mode) {
    case 'allow-all':
      return { allowInternetAccess: true };
    case 'deny-all':
      return { allowInternetAccess: false };
    case 'custom': {
      const allowOut = [
        ...(policy.allowedHosts ?? []),
        ...(policy.allowedCIDRs ?? []),
      ];
      const denyOut = [...(policy.deniedCIDRs ?? [])];
      // `custom` is an allow-list (only allowOut is reachable, everything else
      // denied). E2B enforces that only when ALL_TRAFFIC is in denyOut, and its
      // API rejects an allowOut without it — so add it whenever we allow-list.
      if (allowOut.length > 0 && !denyOut.includes(ALL_TRAFFIC)) {
        denyOut.push(ALL_TRAFFIC);
      }
      const update: SandboxNetworkUpdate = {};
      if (allowOut.length > 0) update.allowOut = allowOut;
      if (denyOut.length > 0) update.denyOut = denyOut;
      if (update.allowOut == null && update.denyOut == null) {
        throw new HarnessCapabilityUnsupportedError({
          harnessId: E2B_PROVIDER_ID,
          message:
            'Custom network policy requires at least one of allowedHosts, allowedCIDRs, or deniedCIDRs to be non-empty.',
        });
      }
      return update;
    }
  }
}
