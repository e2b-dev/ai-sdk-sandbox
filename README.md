# AI SDK - E2B Sandbox

_This package is **experimental** and tracks the AI SDK 7 beta._

Run your agent's code inside [E2B](https://e2b.dev) sandboxes from the [AI SDK](https://ai-sdk.dev). It's the E2B counterpart to [@ai-sdk/sandbox-vercel](https://github.com/vercel/ai/tree/main/packages/sandbox-vercel). Drop it into a `HarnessAgent`, or hand a session straight to your AI SDK tools.

For how the harness itself works, see the [AI SDK harness docs](https://ai-sdk.dev/v7/docs/ai-sdk-harnesses/overview).

## Setup

```bash
npm i @e2b/ai-sdk-sandbox
```

Set `E2B_API_KEY` (or pass `apiKey` in the settings). Calling `createE2BSandbox()` doesn't reach E2B on its own. The sandbox is created when you call `createSession()`.

## Usage

```ts
import { createE2BSandbox } from '@e2b/ai-sdk-sandbox';

const e2bSandbox = createE2BSandbox({ template: 'base' });

const sandboxSession = await e2bSandbox.createSession();
// restricted() returns the same sandbox narrowed to the tool-safe surface
// (file I/O, run, spawn) with no lifecycle or network controls — this is what
// you hand an AI SDK tool's execute().
const restrictedSandboxSession = sandboxSession.restricted();

await restrictedSandboxSession.writeTextFile({ path: 'hello.txt', content: 'hi' });

const { stdout } = await restrictedSandboxSession.run({ command: 'cat hello.txt' });
console.log(stdout); // "hi"

await sandboxSession.stop();
```

`restricted()` gives you an `Experimental_SandboxSession`: the **same underlying sandbox**, narrowed to the tool-facing surface (file I/O, `run`, `spawn`), just a view with the infra bits (`ports`, `getPortUrl`, `setNetworkPolicy`, `stop`) removed. That's the security boundary: code you hand the restricted view can't stop the box or change its network policy. Pass it to an AI SDK tool's `execute()` via `experimental_sandbox`; the full session stays with the harness. (See the [harness docs](https://ai-sdk.dev/v7/docs/ai-sdk-harnesses/overview) for the `restricted()` contract.)

### Settings

Everything goes in the object you pass to `createE2BSandbox(...)`:

```ts
const e2bSandbox = createE2BSandbox({
  template: 'base',                                // any E2B SandboxOpts
  envs: { NODE_ENV: 'production' },
  timeoutMs: 10 * 60 * 1000,                       // optional; defaults to 30 min
  ports: [3000],                                   // provider option
  setupCommands: ['sudo npm install -g pnpm@9'],   // provider option
});
```

Any of E2B's [`SandboxOpts`](https://e2b.dev/docs) (`template`, `envs`, `metadata`, `network`, and so on) are forwarded straight through. The provider adds two more options that aren't part of E2B's SDK:

| option | default | what it does |
| --- | --- | --- |
| `ports` | `[]` | Ports to advertise on `session.ports`. The harness bridge binds to the first one. E2B can reach any listening port through `getHost`, so this is really just the list it advertises. |
| `setupCommands` | `[]` | Commands to run once on a fresh sandbox, before the harness bootstraps. For example, `['sudo npm install -g pnpm@9']` to add pnpm for the claude-code/codex adapters. |

Already have a sandbox? Pass it as `sandbox` to reuse it (handy when you want to share one across sessions). The provider won't touch its lifecycle, so `stop()` and `destroy()` become no-ops and cleanup stays yours.

```ts
import { createE2BSandbox } from '@e2b/ai-sdk-sandbox';
import { Sandbox } from 'e2b';

const e2bSandbox = createE2BSandbox({
  sandbox: await Sandbox.create({ template: 'base' }),
});
```

### Mid-session network policy

You can tighten or loosen outbound access on a sandbox that's already running:

```ts
await sandboxSession.setNetworkPolicy?.({
  mode: 'custom',
  allowedHosts: ['api.example.com'],
  deniedCIDRs: ['169.254.169.254/32'],
});
```

### Running an agent (Claude Code, Codex)

```ts
const agent = new HarnessAgent({
  harness: createClaudeCode(),
  sandbox: createE2BSandbox({
    template: 'base',
    ports: [4000],
    setupCommands: ['sudo npm install -g pnpm@9'],
  }),
});
```

One thing to know about templates: the claude-code adapter installs its own pinned CLI and bridge inside the sandbox with pnpm (it doesn't use a system `claude`), so the only template requirement is pnpm. E2B's `base` template doesn't ship it, so add it with a one-line `setupCommands`, as above. For a faster cold start, bake pnpm into your own template once with `examples/build-template.ts`. A full, runnable version lives in `examples/harness.ts`.

## Good to know

A few E2B-specific behaviors worth knowing:

- `stop()` **pauses** the sandbox, so you can pick it back up later with `resumeSession`. `destroy()` kills it for good.
- Resume works off a session-id tag in the sandbox metadata (E2B assigns the ids, so there's no name to look up), so pass a `sessionId` to `createSession` if you plan to resume.
- `run` and `spawn` switch off E2B's 60-second per-command timeout, so long builds and background servers don't get cut off. The overall sandbox `timeoutMs` still applies.
- When the harness passes `identity` + `onFirstCreate` (e.g. the claude-code/codex bootstrap), the setup runs **once**: it's captured as a snapshot and later sessions fork from it instead of re-running it. The snapshot is matched by name via `listSnapshots`, so even a cold start reuses it. For setup you control ahead of time, a prebuilt template is lighter.

## Examples

- `examples/basic.ts`: the session surface on its own (write, run, spawn)
- `examples/harness.ts`: Claude Code working inside an E2B sandbox
- `examples/resume.ts`: pause a sandbox and pick it back up
- `examples/build-template.ts`: build a custom template (bakes pnpm in) to pass as `template`

Run any of them with `npm run example:basic` (they read `.env`).

## License

MIT
