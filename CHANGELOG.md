# @e2b/ai-sdk-sandbox

## 0.1.0

Initial release. An E2B sandbox provider implementing the AI SDK 7 harness
sandbox spec (`@ai-sdk/harness` `HarnessV1SandboxProvider` /
`HarnessV1NetworkSandboxSession`, and `@ai-sdk/provider-utils`
`Experimental_SandboxSession`) — a drop-in alternative to
`@ai-sdk/sandbox-vercel`.

- `createE2BSandbox()` provider + `experimental_sandbox` tool surface.
- Full `HarnessAgent` support (Claude Code running inside an E2B sandbox over
  the harness bridge), verified end to end.
- Create-new and wrap-existing modes; `resumeSession` via session-id metadata.
- Lifecycle mapped to E2B: `stop()` → `pause()` (resumable), `destroy()` →
  `kill()`.
- `setupCommands` to provision adapter prerequisites (e.g. pnpm) before a
  bootstrap, and `build-template.ts` for a clean pnpm-baked-in template.
