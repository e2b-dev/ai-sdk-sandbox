import type { Sandbox } from 'e2b';
import { CommandExitError, FileNotFoundError } from 'e2b';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { E2BSandboxSession } from './e2b-sandbox-session';

const decoder = new TextDecoder();

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let text = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

/** A background CommandHandle whose onStdout/onStderr fire from `logs`. */
function makeBackgroundHandle(
  opts: { logs?: { stream: 'stdout' | 'stderr'; data: string }[]; exitCode?: number },
  cmdOpts: { onStdout?: (d: string) => void; onStderr?: (d: string) => void },
) {
  for (const e of opts.logs ?? []) {
    if (e.stream === 'stdout') cmdOpts.onStdout?.(e.data);
    else cmdOpts.onStderr?.(e.data);
  }
  const exitCode = opts.exitCode ?? 0;
  return {
    pid: 1234,
    // Model E2B: a non-zero exit rejects wait() with CommandExitError.
    wait: vi.fn(async () => {
      if (exitCode !== 0) {
        throw new CommandExitError({ exitCode, stdout: '', stderr: '', error: '' });
      }
      return { exitCode };
    }),
    kill: vi.fn(async () => true),
  };
}

function makeMockSandbox(overrides: Record<string, unknown> = {}): {
  sandbox: Sandbox;
  spies: { run: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> };
} {
  const run = vi.fn();
  const read = vi.fn();
  const write = vi.fn(async () => {});
  const sandbox = {
    sandboxId: 'sbx_test',
    commands: { run },
    files: { read, write },
    ...overrides,
  } as unknown as Sandbox;
  return { sandbox, spies: { run, read, write } };
}

const session = (sandbox: Sandbox) => new E2BSandboxSession(sandbox);

describe('E2BSandboxSession', () => {
  describe('description', () => {
    it('mentions the sandbox id', () => {
      const { sandbox } = makeMockSandbox();
      expect(session(sandbox).description).toContain('sbx_test');
    });
  });

  describe('run', () => {
    it('maps stdout/stderr/exitCode and sets no cwd by default', async () => {
      const { sandbox, spies } = makeMockSandbox();
      spies.run.mockResolvedValueOnce({ exitCode: 0, stdout: 'hi\n', stderr: 'oops\n' });

      const result = await session(sandbox).run({ command: 'echo hi' });

      expect(spies.run).toHaveBeenCalledWith(
        'echo hi',
        expect.objectContaining({ background: false }),
      );
      // No cwd unless the caller passes one (E2B defaults to the user's home).
      expect(spies.run.mock.calls[0][1].cwd).toBeUndefined();
      expect(result).toEqual({ exitCode: 0, stdout: 'hi\n', stderr: 'oops\n' });
    });

    it('forwards workingDirectory as cwd', async () => {
      const { sandbox, spies } = makeMockSandbox();
      spies.run.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
      await session(sandbox).run({ command: 'ls', workingDirectory: '/work' });
      expect(spies.run).toHaveBeenCalledWith('ls', expect.objectContaining({ cwd: '/work' }));
    });

    it('returns non-zero exits in the result instead of throwing (CommandExitError)', async () => {
      const { sandbox, spies } = makeMockSandbox();
      spies.run.mockRejectedValueOnce(
        new CommandExitError({ exitCode: 2, stdout: 'partial', stderr: 'boom', error: 'x' }),
      );
      const result = await session(sandbox).run({ command: 'false' });
      expect(result).toEqual({ exitCode: 2, stdout: 'partial', stderr: 'boom' });
    });

    it('throws on pre-aborted signal', async () => {
      const { sandbox } = makeMockSandbox();
      const ac = new AbortController();
      ac.abort();
      await expect(
        session(sandbox).run({ command: 'echo', abortSignal: ac.signal }),
      ).rejects.toThrow();
    });
  });

  describe('file I/O', () => {
    it('writeTextFile passes the path straight to files.write', async () => {
      const { sandbox, spies } = makeMockSandbox();
      await session(sandbox).writeTextFile({ path: 'hello.txt', content: 'hi' });
      expect(spies.write).toHaveBeenCalledWith('hello.txt', 'hi', undefined);
    });

    it('writeBinaryFile sends a standalone ArrayBuffer of the bytes', async () => {
      const { sandbox, spies } = makeMockSandbox();
      const bytes = new Uint8Array([0, 1, 2, 255]);
      await session(sandbox).writeBinaryFile({ path: '/abs/file.bin', content: bytes });
      const [path, buffer] = spies.write.mock.calls[0];
      expect(path).toBe('/abs/file.bin');
      expect(new Uint8Array(buffer as ArrayBuffer)).toEqual(bytes);
    });

    it('readBinaryFile returns the bytes', async () => {
      const { sandbox, spies } = makeMockSandbox();
      spies.read.mockResolvedValueOnce(new Uint8Array([1, 2, 3]));
      expect(await session(sandbox).readBinaryFile({ path: '/x' })).toEqual(
        new Uint8Array([1, 2, 3]),
      );
      expect(spies.read).toHaveBeenCalledWith('/x', expect.objectContaining({ format: 'bytes' }));
    });

    it('readBinaryFile maps FileNotFoundError to null', async () => {
      const { sandbox, spies } = makeMockSandbox();
      spies.read.mockRejectedValueOnce(new FileNotFoundError('no such file'));
      expect(await session(sandbox).readBinaryFile({ path: '/missing' })).toBeNull();
    });

    it('readTextFile honours startLine/endLine', async () => {
      const { sandbox, spies } = makeMockSandbox();
      spies.read.mockResolvedValueOnce(new TextEncoder().encode('a\nb\nc\nd\n'));
      const out = await session(sandbox).readTextFile({ path: '/x', startLine: 2, endLine: 3 });
      expect(out).toBe('b\nc');
      // readTextFile reads bytes (so encoding can be honoured), then slices lines.
      expect(spies.read).toHaveBeenCalledWith('/x', expect.objectContaining({ format: 'bytes' }));
    });

    it('readFile returns the native stream and writeFile forwards it', async () => {
      const { sandbox, spies } = makeMockSandbox();
      const payload = new TextEncoder().encode('streamed');
      const inStream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(payload);
          c.close();
        },
      });
      await session(sandbox).writeFile({ path: 'streamed.txt', content: inStream });
      expect(spies.write).toHaveBeenCalledWith('streamed.txt', inStream, undefined);

      spies.read.mockResolvedValueOnce(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(payload);
            c.close();
          },
        }),
      );
      const out = await session(sandbox).readFile({ path: 'streamed.txt' });
      expect(out).not.toBeNull();
      expect(await collect(out!)).toBe('streamed');
    });
  });

  describe('spawn', () => {
    let mock: ReturnType<typeof makeMockSandbox>;
    beforeEach(() => {
      mock = makeMockSandbox();
    });

    it('streams stdout/stderr via callbacks and resolves wait()', async () => {
      mock.spies.run.mockImplementationOnce(async (_cmd: string, opts: any) =>
        makeBackgroundHandle(
          { logs: [{ stream: 'stdout', data: 'out\n' }, { stream: 'stderr', data: 'err\n' }], exitCode: 0 },
          opts,
        ),
      );

      const proc = await session(mock.sandbox).spawn({ command: 'node x.js' });
      expect(mock.spies.run).toHaveBeenCalledWith('node x.js', expect.objectContaining({ background: true }));

      const [stdout, stderr, { exitCode }] = await Promise.all([
        collect(proc.stdout),
        collect(proc.stderr),
        proc.wait(),
      ]);
      expect(stdout).toBe('out\n');
      expect(stderr).toBe('err\n');
      expect(exitCode).toBe(0);
    });

    it('surfaces non-zero exit codes via wait()', async () => {
      mock.spies.run.mockImplementationOnce(async (_cmd: string, opts: any) =>
        makeBackgroundHandle({ exitCode: 7 }, opts),
      );
      const proc = await session(mock.sandbox).spawn({ command: 'exit 7' });
      expect((await proc.wait()).exitCode).toBe(7);
    });

    it('closes streams when the process exits even if wait() is never called', async () => {
      mock.spies.run.mockImplementationOnce(async (_cmd: string, opts: any) =>
        makeBackgroundHandle({ logs: [{ stream: 'stdout', data: 'done\n' }], exitCode: 0 }, opts),
      );
      const proc = await session(mock.sandbox).spawn({ command: 'echo done' });
      // No proc.wait() — collecting must still terminate (stream EOF on exit).
      expect(await collect(proc.stdout)).toBe('done\n');
    });

    it('aborting kills the process and rejects wait() with the abort reason', async () => {
      let killed = false;
      let resolveWait!: (v: { exitCode: number }) => void;
      const waitP = new Promise<{ exitCode: number }>(res => {
        resolveWait = res;
      });
      mock.spies.run.mockImplementationOnce(async () => ({
        pid: 1,
        wait: () => waitP,
        // Killing the process makes wait() settle, as the real SDK does.
        kill: async () => {
          killed = true;
          resolveWait({ exitCode: 137 });
          return true;
        },
      }));
      const ac = new AbortController();
      const proc = await session(mock.sandbox).spawn({
        command: 'sleep 100',
        abortSignal: ac.signal,
      });
      ac.abort(new Error('cancelled'));
      await expect(proc.wait()).rejects.toThrow('cancelled');
      expect(killed).toBe(true);
    });

    it('kill() delegates to the underlying handle', async () => {
      let killed = false;
      mock.spies.run.mockImplementationOnce(async (_cmd: string, opts: any) => ({
        ...makeBackgroundHandle({}, opts),
        kill: vi.fn(async () => {
          killed = true;
          return true;
        }),
      }));
      const proc = await session(mock.sandbox).spawn({ command: 'sleep 10' });
      await proc.kill();
      expect(killed).toBe(true);
    });
  });
});
