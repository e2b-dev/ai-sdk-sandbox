/**
 * Build custom E2B templates with the `e2b` SDK directly. A template's name is
 * what you then pass to `createE2BSandbox({ template })`.
 *
 * Run once: E2B_API_KEY=... npx tsx --env-file-if-exists=.env examples/build-template.ts
 */
import { Template, defaultBuildLogger } from 'e2b';

// A pnpm base template: E2B's base image with pnpm@9 baked in, sized at 2GB.
const pnpmTemplate = Template()
  .fromBaseImage()
  // base runs as the non-root `user`; a global npm install needs root.
  .runCmd('npm install -g pnpm@9', { user: 'root' })
  .runCmd('pnpm --version');

const info = await Template.build(pnpmTemplate, 'pnpm-base', {
  cpuCount: 2,
  memoryMB: 2048,
  onBuildLogs: defaultBuildLogger(),
});
console.log(`\n✅ Built template "${info.name}"`);

// Use it by passing the template name to the provider:
//
//   import { createE2BSandbox } from '@e2b/ai-sdk-sandbox';
//   const sandbox = createE2BSandbox({ template: info.name }); // 'pnpm-base'
//
// then drive it with a HarnessAgent (see harness.ts) or createSession() (see basic.ts).
