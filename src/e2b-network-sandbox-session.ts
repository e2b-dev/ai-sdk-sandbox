import {
  HarnessCapabilityUnsupportedError,
  type HarnessV1NetworkPolicy,
  type HarnessV1NetworkSandboxSession,
  type HarnessV1PortEndpoint,
  type HarnessV1RequestTransformation,
} from '@ai-sdk/harness';
import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';
import { ALL_TRAFFIC } from 'e2b';
import type { Sandbox, SandboxNetworkRule, SandboxNetworkUpdate } from 'e2b';
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
    // The provider resolves the live sandbox's working directory once (via
    // `pwd`) and passes it in for this spec-required property.
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

  getPortEndpoint = async (options: {
    port: number;
    protocol?: 'http' | 'https' | 'ws';
  }): Promise<HarnessV1PortEndpoint> => {
    // E2B port URLs are public and carry auth in the URL itself, so the
    // endpoint needs no extra headers.
    return { url: await this.getPortUrl(options) };
  };

  /** @deprecated Use `getPortEndpoint` instead. */
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
    this.policyUpdate = toE2BNetworkUpdate(policy);
    await this.pushNetwork();
  };

  /**
   * Replace the transformation rules this session manages. Credentials in
   * `transform.headers` are injected by E2B's egress proxy after the request
   * leaves the sandbox — the values never enter the sandbox itself.
   */
  setRequestTransformations = async (
    transformations: ReadonlyArray<HarnessV1RequestTransformation>,
  ): Promise<void> => {
    this.transformations = [...transformations];
    await this.pushNetwork();
  };

  /** Add transformation rules without replacing the ones already managed. */
  addRequestTransformations = async (
    transformations: ReadonlyArray<HarnessV1RequestTransformation>,
  ): Promise<void> => {
    this.transformations.push(...transformations);
    await this.pushNetwork();
  };

  // E2B's network update replaces all egress config atomically (omitted
  // fields are cleared on the server), so the policy and the transformation
  // rules are tracked here and every change sends the merged payload.
  // Runtime updates replace any creation-time `network` config — same
  // behavior `setNetworkPolicy` had before transformations existed.
  private policyUpdate: SandboxNetworkUpdate | null = null;
  private transformations: HarnessV1RequestTransformation[] = [];

  private pushNetwork = async (): Promise<void> => {
    const update: SandboxNetworkUpdate = { ...(this.policyUpdate ?? {}) };
    const rules = toE2BNetworkRules(this.transformations);
    if (Object.keys(rules).length > 0) update.rules = rules;
    await this.sandbox.updateNetwork(update);
  };

  // E2B reaches any listening port via getHost(), so "exposing" a port is just
  // advertising it on `ports`. Full-replacement semantics per the spec. There's
  // no remote call to abort here; `abortSignal` is honoured only as a pre-check
  // for parity with the spec signature and the rest of this class.
  setPorts = async (
    ports: ReadonlyArray<number>,
    options?: { abortSignal?: AbortSignal },
  ): Promise<void> => {
    options?.abortSignal?.throwIfAborted();
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

/**
 * Map harness request transformations onto E2B per-host egress rules.
 *
 * E2B's egress proxy matches rules by host only. Harness `match` refinements
 * beyond `host` (path, method, queryString, headers) cannot be enforced and
 * are applied host-wide — the injected headers still only ever go to the
 * matched host. Note that a rules entry does not allow egress by itself:
 * under an allow-list policy the host must also be reachable.
 */
export function toE2BNetworkRules(
  transformations: ReadonlyArray<HarnessV1RequestTransformation>,
): Record<string, SandboxNetworkRule[]> {
  const rules: Record<string, SandboxNetworkRule[]> = {};
  for (const transformation of transformations) {
    (rules[transformation.match.host] ??= []).push({
      transform: { headers: { ...transformation.transform.headers } },
    });
  }
  return rules;
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
