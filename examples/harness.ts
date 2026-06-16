/**
 * Claude Code running inside an E2B sandbox via the AI SDK harness:
 *
 *   const agent = new HarnessAgent({ harness: createClaudeCode(), sandbox: createE2BSandbox() });
 *
 * Claude Code runs *inside* an E2B sandbox; the host talks to it over the
 * harness bridge (a WebSocket to a port the sandbox exposes via getPortUrl).
 *
 * Zero-build: runs on E2B's public `codex` template (~2GB RAM, node) and adds
 * pnpm via `setupCommands` (the adapter bootstrap needs pnpm). We borrow the
 * `codex` template purely for its 2GB sizing — the public `claude-code`
 * template is only ~1GB and OOM-kills during the adapter's in-sandbox install.
 *
 * For a clean, named, pnpm-baked-in template instead, build `claude-code-harness`
 * with examples/build-template.ts and set E2B_TEMPLATE=claude-code-harness.
 *
 * Run: E2B_API_KEY=... ANTHROPIC_API_KEY=... npx tsx --env-file-if-exists=.env examples/harness.ts
 */
import { HarnessAgent } from '@ai-sdk/harness/agent';
import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createE2BSandbox } from '../src/index.js';

const agent = new HarnessAgent({
  harness: createClaudeCode({
    auth: { anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! } },
    model: process.env.MODEL ?? 'claude-haiku-4-5',
    // First run installs the claude-code CLI inside the sandbox via pnpm; give it room.
    startupTimeoutMs: 300_000,
  }),
  sandbox: createE2BSandbox({
    // Public 2GB template + pnpm at runtime. Override with a custom template
    // (e.g. E2B_TEMPLATE=claude-code-harness) that already has pnpm baked in.
    template: process.env.E2B_TEMPLATE ?? 'codex',
    ports: [4000], // bridge port — the adapter binds to ports[0]
    timeoutMs: 30 * 60 * 1000,
    // Skip the runtime install when the template already ships pnpm.
    ...(process.env.E2B_TEMPLATE
      ? {}
      : { setupCommands: ['sudo npm install -g pnpm@9'] }),
  }),
});

console.log('Creating harness session (boots Claude Code inside E2B)…');
const session = await agent.createSession();
try {
  const result = await agent.generate({
    session,
    prompt: 'Write fizzbuzz.js and run it with node. Show me the output.',
  });
  console.log('\n=== Claude Code result ===\n');
  console.log(result.text);
} finally {
  await session.destroy();
}
