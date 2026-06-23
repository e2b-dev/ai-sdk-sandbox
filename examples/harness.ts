/**
 * Claude Code running inside an E2B sandbox via the AI SDK harness:
 *
 *   const agent = new HarnessAgent({ harness: createClaudeCode(), sandbox: createE2BSandbox() });
 *
 * Claude Code runs *inside* an E2B sandbox; the host talks to it over the
 * harness bridge (a WebSocket to a port the sandbox exposes via getPortUrl).
 *
 * On first boot the adapter installs its own pinned claude-code CLI + bridge
 * inside the sandbox via pnpm (it doesn't use a system `claude`). That install
 * pulls claude-code's ~238MB native binary, and pnpm staging it peaks ~1.5GB, so
 * the sandbox needs ~2GB RAM and pnpm. E2B RAM is fixed at template-build time
 * (not per sandbox), so use a 2GB template with pnpm baked in: build
 * `claude-code-harness` once with build-template.ts. Override via E2B_TEMPLATE.
 *
 * Run: E2B_API_KEY=... ANTHROPIC_API_KEY=... npx tsx --env-file-if-exists=.env examples/harness.ts
 */
import { HarnessAgent } from '@ai-sdk/harness/agent';
import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createE2BSandbox } from '@e2b/ai-sdk-sandbox';

const agent = new HarnessAgent({
  harness: createClaudeCode({
    auth: { anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! } },
    model: process.env.MODEL ?? 'claude-haiku-4-5',
    // First boot installs the claude-code CLI inside the sandbox via pnpm; give it room.
    startupTimeoutMs: 300_000,
  }),
  sandbox: createE2BSandbox({
    // Built by build-template.ts (base image + pnpm + 2GB RAM).
    template: process.env.E2B_TEMPLATE ?? 'claude-code-harness',
    ports: [4000], // bridge port — the adapter binds to ports[0]
    timeoutMs: 30 * 60 * 1000,
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
