/**
 * Build custom E2B templates with the `e2b` SDK directly. A template's name is
 * what you then pass to `createE2BSandbox({ template })`.
 *
 * Templates are E2B's recommended path for fast sandboxes — much lighter and
 * faster than runtime snapshots. Builds run in E2B's cloud (no local Docker).
 *
 * Run once: E2B_API_KEY=... npx tsx --env-file-if-exists=.env examples/build-template.ts
 *
 * Tip: a brand-new template is slow on its very first sandbox — spin one up and
 * kill it once to pre-warm it.
 */
import { Template, waitForPort } from 'e2b';

// A claude-code harness template: E2B's base image + pnpm@9, with 2GB RAM.
// The claude-code/codex adapters install their CLI + bridge in-sandbox via
// pnpm, which the base template lacks and which OOMs at ~512MB-1GB; this bakes
// pnpm in and gives enough headroom. (Or skip this and use the public `codex`
// template + `setupCommands: ['sudo npm install -g pnpm@9']` — see examples/harness.ts.)
const claudeCode = Template()
  .fromBaseImage()
  // base runs as the non-root `user`; a global npm install needs root.
  .runCmd('npm install -g pnpm@9', { user: 'root' })
  .runCmd('pnpm --version');

const info = await Template.build(claudeCode, 'claude-code-harness', {
  cpuCount: 2,
  memoryMB: 2048,
  onBuildLogs: log => process.stdout.write(String(log) + '\n'),
});
console.log(`\n✅ Built template "${info.name}"`);

/**
 * Reference: pre-warm a long-running server into the template's hot memory
 * layer. `setStartCmd` runs as the template's final build step and is captured
 * in memory, so sandboxes created from this template come up with the server
 * already listening; `waitForPort` makes the build wait until it's actually
 * serving before that snapshot is taken. (Defined for illustration — not built
 * by this script; call it if you want it.)
 */
export function buildPrewarmedServerTemplate() {
  const template = Template()
    .fromBaseImage()
    .setStartCmd('python3 -m http.server 3000', waitForPort(3000));

  return Template.build(template, 'prewarmed-server', { memoryMB: 1024 });
}
