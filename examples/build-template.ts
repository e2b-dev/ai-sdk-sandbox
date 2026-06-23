/**
 * Build custom E2B templates with the `e2b` SDK directly. A template's name is
 * what you then pass to `createE2BSandbox({ template })`.
 *
 * Run once: E2B_API_KEY=... npx tsx --env-file-if-exists=.env examples/build-template.ts
 */
import { Template } from 'e2b';

// A claude-code harness template: E2B's base image with pnpm@9 baked in. On
// first boot the adapter installs its own pinned claude-code CLI + bridge
// in-sandbox via pnpm, so the only thing a template needs is pnpm; baking it in
// skips the per-session `setupCommands` install and speeds up cold starts.
// (No need to bake claude itself — the adapter installs its pinned version.)
const claudeCode = Template()
  .fromBaseImage()
  // base runs as the non-root `user`; a global npm install needs root.
  .runCmd('npm install -g pnpm@9', { user: 'root' })
  .runCmd('pnpm --version');

const info = await Template.build(claudeCode, 'claude-code-harness', {
  cpuCount: 2,
  memoryMB: 1024, // base is ~512MB; give the in-sandbox install some headroom
  onBuildLogs: log => process.stdout.write(String(log) + '\n'),
});
console.log(`\n✅ Built template "${info.name}"`);

// Use it by passing the template name to the provider:
//
//   import { createE2BSandbox } from '@e2b/ai-sdk-sandbox';
//   const sandbox = createE2BSandbox({ template: info.name }); // 'claude-code-harness'
//
// then drive it with a HarnessAgent (see harness.ts) or createSession() (see basic.ts).
