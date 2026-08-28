import {
  extractLines,
  type Experimental_SandboxSession,
  type Experimental_SandboxProcess,
} from '@ai-sdk/provider-utils';
import { Sandbox, CommandExitError, FileNotFoundError } from 'e2b';
import type { CommandStartOpts } from 'e2b';

/**
 * `Experimental_SandboxSession` implementation backed by an E2B `Sandbox`. This
 * is the tool-safe surface (file I/O, `run`, `spawn`); it is what
 * `E2BNetworkSandboxSession.restricted()` returns and is not constructed
 * directly by consumers. The network sandbox session owns the lifetime of the
 * underlying sandbox.
 */
export class E2BSandboxSession implements Experimental_SandboxSession {
  constructor(protected readonly sandbox: Sandbox) {}

  get description(): string {
    return [
      `E2B Sandbox (id: ${this.sandbox.sandboxId}).`,
      'Filesystem changes persist for the lifetime of the sandbox.',
    ].join('\n');
  }

  // E2B resolves relative paths and a command's default cwd against the sandbox
  // user's home directory, so paths are passed through as-is and `cwd` is only
  // set when the caller provides one.

  async run({
    command,
    workingDirectory,
    env,
    abortSignal,
  }: {
    command: string;
    workingDirectory?: string;
    env?: Record<string, string>;
    abortSignal?: AbortSignal;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    abortSignal?.throwIfAborted();

    // Run in the background to keep a killable handle: E2B's request signal only
    // disconnects the stream, it does not terminate the command, so honouring the
    // `abortSignal` contract (the running process is killed on abort) means
    // killing the handle explicitly. The handle buffers stdout/stderr, so the
    // result still carries the full output.
    const opts: CommandStartOpts & { background: true } = {
      background: true,
      envs: env,
      timeoutMs: 0, // disable E2B's 60s default; agent commands run long.
      signal: abortSignal,
      ...(workingDirectory !== undefined ? { cwd: workingDirectory } : {}),
    };

    // A signal abort during start rejects before a handle exists; report the
    // abort reason rather than E2B's request error.
    const handle = await this.sandbox.commands
      .run(command, opts)
      .catch((error: unknown) => {
        if (abortSignal?.aborted) {
          throw abortSignal.reason ?? new DOMException('Aborted', 'AbortError');
        }
        throw error;
      });

    // Kill the command on abort; closing the request alone leaves it running.
    if (abortSignal?.aborted) void handle.kill().catch(() => {});
    const onAbort = () => void handle.kill().catch(() => {});
    abortSignal?.addEventListener('abort', onAbort, { once: true });

    try {
      const result = await handle.wait();
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (error) {
      // The abort contract wants the abort reason surfaced, not E2B's error.
      if (abortSignal?.aborted) {
        throw abortSignal.reason ?? new DOMException('Aborted', 'AbortError');
      }
      // Spec: `run` reports non-zero exits in the result, it does not throw.
      // (E2B's `wait()` throws `CommandExitError` on non-zero exit.)
      if (error instanceof CommandExitError) {
        return {
          exitCode: error.exitCode,
          stdout: error.stdout,
          stderr: error.stderr,
        };
      }
      throw error;
    } finally {
      abortSignal?.removeEventListener('abort', onAbort);
    }
  }

  async spawn({
    command,
    workingDirectory,
    env,
    abortSignal,
  }: {
    command: string;
    workingDirectory?: string;
    env?: Record<string, string>;
    abortSignal?: AbortSignal;
  }): Promise<Experimental_SandboxProcess> {
    abortSignal?.throwIfAborted();

    // E2B streams a background command's output through onStdout/onStderr
    // callbacks, so the process helper supplies them and we wire them into the
    // command's start options.
    return createSandboxProcess(abortSignal, ({ onStdout, onStderr }) => {
      const opts: CommandStartOpts & { background: true } = {
        background: true,
        envs: env,
        timeoutMs: 0, // disable E2B's 60s default; spawned processes are long-lived.
        onStdout,
        onStderr,
        signal: abortSignal,
        ...(workingDirectory !== undefined ? { cwd: workingDirectory } : {}),
      };
      return this.sandbox.commands.run(command, opts);
    });
  }

  async readFile({
    path,
    abortSignal,
  }: {
    path: string;
    abortSignal?: AbortSignal;
  }): Promise<ReadableStream<Uint8Array> | null> {
    abortSignal?.throwIfAborted();
    try {
      return await this.sandbox.files.read(path, {
        format: 'stream',
        ...(abortSignal ? { signal: abortSignal } : {}),
      });
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        return null;
      }
      throw error;
    }
  }

  async readBinaryFile({
    path,
    abortSignal,
  }: {
    path: string;
    abortSignal?: AbortSignal;
  }): Promise<Uint8Array | null> {
    abortSignal?.throwIfAborted();
    try {
      return await this.sandbox.files.read(path, {
        format: 'bytes',
        ...(abortSignal ? { signal: abortSignal } : {}),
      });
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        return null;
      }
      throw error;
    }
  }

  async readTextFile({
    path,
    encoding = 'utf-8',
    startLine,
    endLine,
    abortSignal,
  }: {
    path: string;
    encoding?: string;
    startLine?: number;
    endLine?: number;
    abortSignal?: AbortSignal;
  }): Promise<string | null> {
    const bytes = await this.readBinaryFile({ path, abortSignal });
    if (bytes == null) {
      return null;
    }
    const text = Buffer.from(bytes).toString(encoding as BufferEncoding);
    return extractLines({ text, startLine, endLine });
  }

  async writeFile({
    path,
    content,
    abortSignal,
  }: {
    path: string;
    content: ReadableStream<Uint8Array>;
    abortSignal?: AbortSignal;
  }): Promise<void> {
    abortSignal?.throwIfAborted();
    await this.sandbox.files.write(
      path,
      content,
      abortSignal ? { signal: abortSignal } : undefined,
    );
  }

  async writeBinaryFile({
    path,
    content,
    abortSignal,
  }: {
    path: string;
    content: Uint8Array;
    abortSignal?: AbortSignal;
  }): Promise<void> {
    abortSignal?.throwIfAborted();
    // Copy exactly this view's bytes into a standalone ArrayBuffer. (Don't use
    // `content.slice().buffer` — for a Node `Buffer`, `.slice()` returns a view
    // onto the shared slab, so `.buffer` could include unrelated bytes.)
    const bytes = new Uint8Array(content).buffer;
    await this.sandbox.files.write(
      path,
      bytes,
      abortSignal ? { signal: abortSignal } : undefined,
    );
  }

  async writeTextFile({
    path,
    content,
    encoding = 'utf-8',
    abortSignal,
  }: {
    path: string;
    content: string;
    encoding?: string;
    abortSignal?: AbortSignal;
  }): Promise<void> {
    const buffer = Buffer.from(content, encoding as BufferEncoding);
    await this.writeBinaryFile({
      path,
      content: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
      abortSignal,
    });
  }
}

/** Minimal view of an E2B background command handle. */
type BackgroundCommand = {
  pid: number;
  wait: () => Promise<{ exitCode: number }>;
  kill: () => Promise<unknown>;
};

/**
 * Adapt an E2B background command to an `Experimental_SandboxProcess`. The
 * caller's `start` receives `onStdout`/`onStderr` to wire into the command and
 * returns the handle; output is re-encoded onto Web `ReadableStream`s, which
 * close once the process is awaited or killed.
 */
async function createSandboxProcess(
  abortSignal: AbortSignal | undefined,
  start: (handlers: {
    onStdout: (data: string) => void;
    onStderr: (data: string) => void;
  }) => Promise<BackgroundCommand>,
): Promise<Experimental_SandboxProcess> {
  const encoder = new TextEncoder();
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  let stderrController!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start: controller => {
      stdoutController = controller;
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start: controller => {
      stderrController = controller;
    },
  });

  let closed = false;
  const closeStreams = () => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      stdoutController.close();
    } catch {
      /* already closed */
    }
    try {
      stderrController.close();
    } catch {
      /* already closed */
    }
  };

  // A signal abort during start rejects before a handle exists; report the
  // abort reason rather than E2B's request error. (The remote process can't be
  // killed here — there's no handle yet — but the rejection is at least correct.)
  const handle = await start({
    onStdout: data => stdoutController.enqueue(encoder.encode(data)),
    onStderr: data => stderrController.enqueue(encoder.encode(data)),
  }).catch((error: unknown) => {
    if (abortSignal?.aborted) {
      throw abortSignal.reason ?? new DOMException('Aborted', 'AbortError');
    }
    throw error;
  });

  // Resolve the exit code once, and close the output streams as soon as the
  // process exits — independent of whether the caller awaits `wait()`. (E2B's
  // `wait()` throws `CommandExitError` on non-zero exit; the spec wants the
  // code, not a throw.)
  const exit: Promise<{ exitCode: number }> = handle.wait().then(
    result => ({ exitCode: result.exitCode }),
    error => {
      if (error instanceof CommandExitError) {
        return { exitCode: error.exitCode };
      }
      throw error;
    },
  );
  exit.then(closeStreams, closeStreams);

  // On abort, kill the remote process (E2B does not necessarily terminate a
  // detached command when the request signal aborts) and make `wait()` reject
  // with the abort reason, per the sandbox-process contract.
  if (abortSignal?.aborted) {
    void handle.kill().catch(() => {});
  } else if (abortSignal) {
    const onAbort = () => void handle.kill().catch(() => {});
    abortSignal.addEventListener('abort', onAbort, { once: true });
    // `exit` may reject (non-CommandExitError); swallow here so the cleanup
    // chain can't surface as an unhandled rejection.
    void exit
      .finally(() => abortSignal.removeEventListener('abort', onAbort))
      .catch(() => {});
  }

  return {
    pid: handle.pid,
    stdout,
    stderr,
    async wait(): Promise<{ exitCode: number }> {
      let result: { exitCode: number } | undefined;
      try {
        result = await exit;
      } catch (error) {
        if (!abortSignal?.aborted) {
          throw error;
        }
      }
      if (abortSignal?.aborted) {
        throw abortSignal.reason ?? new DOMException('Aborted', 'AbortError');
      }
      return result as { exitCode: number };
    },
    async kill(): Promise<void> {
      await handle.kill();
      // The process exit (above) drives stream closure.
    },
  };
}
