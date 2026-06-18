/**
 * The session surface, end to end — the E2B parallel of the usage shown in
 * `@ai-sdk/sandbox-vercel`'s README. No LLM, just the sandbox: create a
 * session, write a file, run a command, spawn a streaming process.
 *
 * `restricted()` returns an `Experimental_SandboxSession`: the same underlying
 * sandbox, narrowed to the tool-safe surface (file I/O, run, spawn) with no
 * lifecycle or network controls — exactly what you hand an AI SDK tool's
 * `execute()` via `experimental_sandbox`. This example has no tool, so the call
 * is here only to show that shape; the file/run/spawn calls below go through it
 * while lifecycle (`destroy`) stays on the full `networkSession`.
 *
 * Run: E2B_API_KEY=... npx tsx --env-file-if-exists=.env examples/basic.ts
 */
import { createE2BSandbox } from '@e2b/ai-sdk-sandbox';

const networkSession = await createE2BSandbox({
  template: 'base',
}).createSession();
// Same sandbox, narrower surface — illustrative here (nothing consumes it).
const session = networkSession.restricted();

try {
  console.log(networkSession.description);

  // file I/O + buffered run (relative paths resolve against the working dir)
  await session.writeTextFile({ path: 'hello.txt', content: 'hi from e2b' });
  const { stdout } = await session.run({ command: 'cat hello.txt' });
  console.log('run →', stdout.trim());

  console.log('readTextFile →', await session.readTextFile({ path: 'hello.txt' }));
  console.log('missing file →', await session.readTextFile({ path: 'nope.txt' }));

  // spawn: streaming output + kill
  const proc = await session.spawn({
    command: 'for i in 1 2 3; do echo tick $i; sleep 1; done',
  });
  const reader = proc.stdout.getReader();
  const { value } = await reader.read();
  console.log('spawn first chunk →', new TextDecoder().decode(value).trim());
  reader.releaseLock();
  await proc.kill();
  console.log('killed, exit code →', (await proc.wait()).exitCode);
} finally {
  // stop() would pause the sandbox (resumable — see resume.ts); destroy() removes it.
  await networkSession.destroy?.();
  console.log('sandbox destroyed');
}
