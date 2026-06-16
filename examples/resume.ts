/**
 * E2B-specific: pause + resume. `stop()` pauses the sandbox (filesystem and
 * memory preserved); `resumeSession({ sessionId })` reconnects to it later —
 * even from a different process — by looking it up via the session-id metadata
 * tag. State written before the pause is still there after the resume.
 *
 * Run: E2B_API_KEY=... npx tsx --env-file-if-exists=.env examples/resume.ts
 */
import { createE2BSandbox } from '../src/index.js';

const provider = createE2BSandbox({ template: 'base' });
const sessionId = `demo-${process.pid}`;

// First session: write some state, then pause.
const first = await provider.createSession({ sessionId });
await first.writeTextFile({ path: 'state.txt', content: 'survived the pause' });
console.log('wrote state, pausing…');
await first.stop(); // pause (resumable)

// Later (could be a different process): reconnect and read it back.
const resumed = await provider.resumeSession!({ sessionId });
try {
  const state = await resumed.readTextFile({ path: 'state.txt' });
  console.log('resumed →', state);
} finally {
  await resumed.destroy?.();
  console.log('sandbox destroyed');
}
