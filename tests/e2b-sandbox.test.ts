import type { Sandbox } from 'e2b';
import { CommandExitError } from 'e2b';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createE2BSandbox, snapshotName } from '../src/e2b-sandbox';

/**
 * Wrap a result as a background CommandHandle — what `commands.run` returns under
 * `background: true`. A non-zero exit rejects `wait()` with `CommandExitError`,
 * matching E2B; `E2BSandboxSession.run` maps that back to a result.
 */
function cmdHandle(result: { exitCode: number; stdout: string; stderr: string }) {
  return {
    pid: 1,
    wait: async () => {
      if (result.exitCode !== 0) throw new CommandExitError({ ...result, error: '' });
      return result;
    },
    kill: async () => true,
  };
}

const { createMock, connectMock, listMock, listSnapshotsMock } = vi.hoisted(
  () => ({
    createMock: vi.fn(),
    connectMock: vi.fn(),
    listMock: vi.fn(),
    listSnapshotsMock: vi.fn(),
  }),
);

vi.mock('e2b', async importActual => {
  const actual = await importActual<typeof import('e2b')>();
  return {
    ...actual,
    Sandbox: {
      create: createMock,
      connect: connectMock,
      list: listMock,
      listSnapshots: listSnapshotsMock,
    },
  };
});

function makeMockSandbox(overrides: Record<string, unknown> = {}) {
  // background:false (e.g. the provider's own `pwd`) returns a result directly;
  // background:true (E2BSandboxSession.run) returns a killable handle.
  const run = vi.fn(async (_command: string, opts?: { background?: boolean }) =>
    opts?.background
      ? cmdHandle({ exitCode: 0, stdout: '', stderr: '' })
      : { exitCode: 0, stdout: '/home/user\n', stderr: '' },
  );
  const getHost = vi.fn((port: number) => `${port}-sbx.e2b.app`);
  const updateNetwork = vi.fn(async () => {});
  const pause = vi.fn(async () => true);
  const kill = vi.fn(async () => {});
  const createSnapshot = vi.fn(async ({ name }: { name: string }) => ({
    snapshotId: `team/${name}:default`,
    names: [`team/${name}`],
  }));
  const sandbox = {
    sandboxId: 'sbx_harness',
    commands: { run },
    files: { read: vi.fn(), write: vi.fn() },
    getHost,
    updateNetwork,
    pause,
    kill,
    createSnapshot,
    ...overrides,
  } as unknown as Sandbox;
  return { sandbox, spies: { run, getHost, updateNetwork, pause, kill, createSnapshot } };
}

/** A one-page listSnapshots paginator over the given SnapshotInfo-ish items. */
function snapshotPage(items: Array<{ snapshotId: string; names: string[] }>) {
  let served = false;
  return {
    get hasNext() {
      return !served;
    },
    nextItems: vi.fn(async () => {
      served = true;
      return items;
    }),
  };
}

beforeEach(() => {
  createMock.mockReset();
  connectMock.mockReset();
  listMock.mockReset();
  listSnapshotsMock.mockReset();
  // The snapshot cache lives on globalThis; clear it between tests.
  (
    globalThis as { [k: symbol]: Map<string, unknown> | undefined }
  )[Symbol.for('ai-sdk.harness.e2b-snapshot-names')]?.clear();
});

describe('createE2BSandbox (wrap existing)', () => {
  it('advertises bridgePorts on the session', async () => {
    const { sandbox } = makeMockSandbox();
    const session = await createE2BSandbox({ sandbox, bridgePorts: [3000, 4000] }).createSession();
    expect(session.ports).toEqual([3000, 4000]);
  });

  it('restricted() returns a tool-safe session over the same sandbox', async () => {
    const { sandbox, spies } = makeMockSandbox();
    spies.run.mockResolvedValueOnce({ exitCode: 0, stdout: '/home/user\n', stderr: '' }); // pwd
    spies.run.mockResolvedValueOnce(cmdHandle({ exitCode: 0, stdout: 'ok\n', stderr: '' })); // echo
    const session = await createE2BSandbox({ sandbox }).createSession();
    const result = await session.restricted().run({ command: 'echo ok' });
    expect(result.stdout).toBe('ok\n');
  });

  it('stop and destroy are no-ops (caller owns lifecycle)', async () => {
    const { sandbox, spies } = makeMockSandbox();
    const session = await createE2BSandbox({ sandbox }).createSession();
    await session.stop();
    await session.destroy?.();
    expect(spies.pause).not.toHaveBeenCalled();
    expect(spies.kill).not.toHaveBeenCalled();
  });

  describe('getPortUrl', () => {
    it('builds an https URL from getHost', async () => {
      const { sandbox, spies } = makeMockSandbox();
      const session = await createE2BSandbox({ sandbox }).createSession();
      const url = await session.getPortUrl({ port: 4000 });
      expect(spies.getHost).toHaveBeenCalledWith(4000);
      expect(url).toBe('https://4000-sbx.e2b.app');
    });

    it('upgrades ws to wss (E2B terminates TLS)', async () => {
      const { sandbox } = makeMockSandbox();
      const session = await createE2BSandbox({ sandbox }).createSession();
      expect(await session.getPortUrl({ port: 4000, protocol: 'ws' })).toBe('wss://4000-sbx.e2b.app');
    });
  });

  describe('setNetworkPolicy', () => {
    it('maps allow-all / deny-all to allowInternetAccess', async () => {
      const { sandbox, spies } = makeMockSandbox();
      const session = await createE2BSandbox({ sandbox }).createSession();
      await session.setNetworkPolicy!({ mode: 'allow-all' });
      expect(spies.updateNetwork).toHaveBeenCalledWith({ allowInternetAccess: true });
      await session.setNetworkPolicy!({ mode: 'deny-all' });
      expect(spies.updateNetwork).toHaveBeenCalledWith({ allowInternetAccess: false });
    });

    it('maps custom hosts + denied CIDRs to allowOut/denyOut, adding ALL_TRAFFIC to deny', async () => {
      const { sandbox, spies } = makeMockSandbox();
      const session = await createE2BSandbox({ sandbox }).createSession();
      await session.setNetworkPolicy!({
        mode: 'custom',
        allowedHosts: ['api.example.com'],
        deniedCIDRs: ['169.254.169.254/32'],
      });
      // allow-list semantics: E2B needs ALL_TRAFFIC in denyOut so everything
      // outside the allow-list is blocked.
      expect(spies.updateNetwork).toHaveBeenCalledWith({
        allowOut: ['api.example.com'],
        denyOut: ['169.254.169.254/32', '0.0.0.0/0'],
      });
    });

    it('deny-only custom policy does not force ALL_TRAFFIC', async () => {
      const { sandbox, spies } = makeMockSandbox();
      const session = await createE2BSandbox({ sandbox }).createSession();
      await session.setNetworkPolicy!({
        mode: 'custom',
        allowedCIDRs: undefined as never,
        deniedCIDRs: ['10.0.0.0/8'],
      } as never);
      expect(spies.updateNetwork).toHaveBeenCalledWith({ denyOut: ['10.0.0.0/8'] });
    });

    it('throws on an empty custom policy', async () => {
      const { sandbox } = makeMockSandbox();
      const session = await createE2BSandbox({ sandbox }).createSession();
      // An empty custom policy is invalid (the type forbids it); assert the runtime guard.
      await expect(
        session.setNetworkPolicy!({ mode: 'custom' } as never),
      ).rejects.toThrow();
    });
  });

  describe('setPorts', () => {
    it('replaces the advertised port list', async () => {
      const { sandbox } = makeMockSandbox();
      const session = await createE2BSandbox({ sandbox, bridgePorts: [4000] }).createSession();
      await session.setPorts!([5000, 6000]);
      expect(session.ports).toEqual([5000, 6000]);
    });

    it('throws on a pre-aborted signal and leaves ports unchanged', async () => {
      const { sandbox } = makeMockSandbox();
      const session = await createE2BSandbox({ sandbox, bridgePorts: [4000] }).createSession();
      await expect(
        session.setPorts!([5000], { abortSignal: AbortSignal.abort() }),
      ).rejects.toThrow();
      expect(session.ports).toEqual([4000]);
    });
  });

  describe('bridgePorts', () => {
    it('is exposed on the provider when set', () => {
      const { sandbox } = makeMockSandbox();
      expect(createE2BSandbox({ sandbox, bridgePorts: [5001, 5002] }).bridgePorts).toEqual([5001, 5002]);
    });
    it('is undefined when not set', () => {
      const { sandbox } = makeMockSandbox();
      expect(createE2BSandbox({ sandbox }).bridgePorts).toBeUndefined();
    });
  });
});

describe('createE2BSandbox (create from scratch)', () => {
  it('applies a 30 minute default timeout', async () => {
    createMock.mockResolvedValueOnce(makeMockSandbox().sandbox);
    await createE2BSandbox({}).createSession();
    expect(createMock.mock.calls[0][0]).toMatchObject({ timeoutMs: 30 * 60 * 1_000 });
  });

  it('forwards the abortSignal into Sandbox.create', async () => {
    createMock.mockResolvedValueOnce(makeMockSandbox().sandbox);
    const ac = new AbortController();
    await createE2BSandbox({}).createSession({ abortSignal: ac.signal });
    expect(createMock.mock.calls[0][0]).toMatchObject({ signal: ac.signal });
  });

  it('kills the sandbox when a setupCommand fails (no orphaned VM)', async () => {
    const { sandbox, spies } = makeMockSandbox();
    spies.run
      .mockResolvedValueOnce({ exitCode: 0, stdout: '/home/user\n', stderr: '' }) // pwd
      .mockResolvedValueOnce(cmdHandle({ exitCode: 1, stdout: '', stderr: 'nope' })); // setup cmd
    createMock.mockResolvedValueOnce(sandbox);
    await expect(
      createE2BSandbox({ setupCommands: ['do-thing'] }).createSession(),
    ).rejects.toThrow(/setupCommand failed/);
    expect(spies.kill).toHaveBeenCalledTimes(1);
  });

  it('respects an explicit timeout and tags the sessionId in metadata', async () => {
    createMock.mockResolvedValueOnce(makeMockSandbox().sandbox);
    await createE2BSandbox({ timeoutMs: 60_000 }).createSession({ sessionId: 's1' });
    expect(createMock.mock.calls[0][0]).toMatchObject({
      timeoutMs: 60_000,
      metadata: { aiSdkSessionId: 's1' },
    });
  });

  it('runs setupCommands before returning, failing loudly on non-zero exit', async () => {
    const { sandbox, spies } = makeMockSandbox();
    spies.run
      .mockResolvedValueOnce({ exitCode: 0, stdout: '/home/user\n', stderr: '' }) // pwd
      .mockResolvedValueOnce(cmdHandle({ exitCode: 1, stdout: '', stderr: 'nope' })); // setup cmd
    createMock.mockResolvedValueOnce(sandbox);
    await expect(
      createE2BSandbox({ setupCommands: ['do-thing'] }).createSession(),
    ).rejects.toThrow(/setupCommand failed/);
  });

  it('stop pauses and destroy kills an owned sandbox', async () => {
    const { sandbox, spies } = makeMockSandbox();
    createMock.mockResolvedValueOnce(sandbox);
    const session = await createE2BSandbox({}).createSession();
    await session.stop();
    expect(spies.pause).toHaveBeenCalledTimes(1);

    const fresh = makeMockSandbox();
    createMock.mockResolvedValueOnce(fresh.sandbox);
    const session2 = await createE2BSandbox({}).createSession();
    await session2.destroy?.();
    expect(fresh.spies.kill).toHaveBeenCalledTimes(1);
  });

  it('destroy still kills an owned sandbox even when a prior stop failed', async () => {
    const { sandbox, spies } = makeMockSandbox({
      pause: vi.fn(async () => {
        throw new Error('pause failed');
      }),
    });
    createMock.mockResolvedValueOnce(sandbox);
    const session = await createE2BSandbox({}).createSession();

    // A failed stop must not leave the sandbox un-destroyable.
    await expect(session.stop()).rejects.toThrow(/pause failed/);
    await session.destroy?.();
    expect(spies.kill).toHaveBeenCalledTimes(1);
  });

  it('resumeSession looks the sandbox up by metadata and connects', async () => {
    const { sandbox } = makeMockSandbox();
    listMock.mockReturnValueOnce({ nextItems: async () => [{ sandboxId: 'sbx_found' }] });
    connectMock.mockResolvedValueOnce(sandbox);

    await createE2BSandbox({}).resumeSession!({ sessionId: 's1' });

    expect(listMock).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ metadata: { aiSdkSessionId: 's1' } }) }),
    );
    expect(connectMock.mock.calls[0][0]).toBe('sbx_found');
  });

  it('resumeSession throws when no sandbox matches', async () => {
    listMock.mockReturnValueOnce({ nextItems: async () => [] });
    await expect(
      createE2BSandbox({}).resumeSession!({ sessionId: 'missing' }),
    ).rejects.toThrow(/No resumable E2B sandbox/);
  });
});

describe('createE2BSandbox (per-identity snapshot reuse)', () => {
  const onFirstCreate = () => vi.fn(async () => {});

  it('builds the snapshot once on a miss, then forks the session from it', async () => {
    const template = makeMockSandbox({ sandboxId: 'sbx_template' });
    const fork = makeMockSandbox({ sandboxId: 'sbx_fork' });
    listSnapshotsMock.mockReturnValueOnce(snapshotPage([])); // none exist yet
    createMock
      .mockResolvedValueOnce(template.sandbox) // build: template sandbox
      .mockResolvedValueOnce(fork.sandbox); // fork: session sandbox
    const hook = onFirstCreate();

    const session = await createE2BSandbox({
      setupCommands: ['echo setup'],
    }).createSession({ sessionId: 's1', identity: 'recipe-A', onFirstCreate: hook });

    const name = snapshotName('recipe-A');
    // ran setup + hook on the template sandbox, snapshotted it, killed it
    expect(template.spies.run).toHaveBeenCalledWith(
      'echo setup',
      expect.anything(),
    );
    expect(hook).toHaveBeenCalledTimes(1);
    expect(template.spies.createSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ name }),
    );
    expect(template.spies.kill).toHaveBeenCalledTimes(1);
    // forked the session from the snapshot name (template arg), no hook re-run
    expect(createMock.mock.calls[1][0]).toBe(name);
    expect(createMock.mock.calls[1][1]).toMatchObject({
      metadata: { aiSdkSessionId: 's1' },
    });
    expect(createMock.mock.calls[1][1]).not.toHaveProperty('template');
    expect(session.id).toBe('sbx_fork');
  });

  it('reuses an existing snapshot (cross-process) without building', async () => {
    const fork = makeMockSandbox({ sandboxId: 'sbx_fork' });
    const name = snapshotName('recipe-B');
    listSnapshotsMock.mockReturnValueOnce(
      snapshotPage([{ snapshotId: `team/${name}:default`, names: [`team/${name}`] }]),
    );
    createMock.mockResolvedValueOnce(fork.sandbox); // only the fork, no build
    const hook = onFirstCreate();

    await createE2BSandbox({}).createSession({
      sessionId: 's1',
      identity: 'recipe-B',
      onFirstCreate: hook,
    });

    expect(hook).not.toHaveBeenCalled(); // found → no build
    expect(createMock).toHaveBeenCalledTimes(1); // only the fork
    expect(createMock.mock.calls[0][0]).toBe(name);
  });

  it('builds once per identity within a process, forks each session', async () => {
    const template = makeMockSandbox({ sandboxId: 'sbx_template' });
    listSnapshotsMock.mockReturnValueOnce(snapshotPage([]));
    createMock
      .mockResolvedValueOnce(template.sandbox) // build
      .mockResolvedValueOnce(makeMockSandbox({ sandboxId: 'sbx_fork1' }).sandbox)
      .mockResolvedValueOnce(makeMockSandbox({ sandboxId: 'sbx_fork2' }).sandbox);
    const hook = onFirstCreate();
    const provider = createE2BSandbox({});

    await provider.createSession({ sessionId: 'a', identity: 'recipe-C', onFirstCreate: hook });
    await provider.createSession({ sessionId: 'b', identity: 'recipe-C', onFirstCreate: hook });

    expect(hook).toHaveBeenCalledTimes(1); // built once
    expect(listSnapshotsMock).toHaveBeenCalledTimes(1); // looked up once (cached after)
    expect(createMock).toHaveBeenCalledTimes(3); // 1 template + 2 forks
  });

  it('without identity, keeps the fresh-create path (hook runs every time)', async () => {
    const sb = makeMockSandbox();
    createMock.mockResolvedValueOnce(sb.sandbox);
    const hook = onFirstCreate();

    await createE2BSandbox({}).createSession({ onFirstCreate: hook }); // no identity

    expect(listSnapshotsMock).not.toHaveBeenCalled();
    expect(sb.spies.createSnapshot).not.toHaveBeenCalled();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});
