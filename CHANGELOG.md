# @e2b/ai-sdk-sandbox

## 0.3.0

### Minor Changes

- 86ebbb2: Implement `setRequestTransformations` / `addRequestTransformations` on the E2B network sandbox session, mapping harness request transformations to E2B per-host egress transform rules. Harness adapters (e.g. `@ai-sdk/harness-claude-code`) now broker credentials at the egress proxy instead of forwarding real API keys into the sandbox. `setNetworkPolicy` preserves the creation-time network baseline and managed transformation rules on every update. Fixes #5.

## 0.2.1

### Patch Changes

- 4dc9085: Fix the release pipeline so a successful publish no longer reports failure.

  The package script was named `publish`, which npm treats as a lifecycle hook and
  runs after a successful `npm publish`. That re-entered `changeset publish`, and the
  nested attempt raced registry propagation: if the just-published version was not yet
  visible it tried to publish it again and failed with "cannot publish over the
  previously published versions", turning a completed release into a red run with the
  version bump commit skipped. The script is now named `release`, so nothing re-enters.

  No runtime code changed; the published module is identical to 0.2.0.

## 0.2.0

### Minor Changes

- 0c4c040: Update dependencies and add SDK integration attribution.

  - Bump `e2b` to `^2.35.0`, `@ai-sdk/harness` to `^1.0.39`, and `@ai-sdk/provider-utils` to `^5.0.12`.
  - Tag requests to E2B with an integration `User-Agent` (`e2b-ai-sdk-sandbox/<version>`) via `ConnectionConfig.setIntegration`, so E2B can attribute traffic from this provider. The version is derived from `package.json`.
  - Look snapshots up with the server-side `name` filter (e2b 2.34+) instead of paging through every team snapshot, and simplify the list-paginator calls (`listSnapshots`/`list`) to rely on the connection options captured at construction rather than re-passing them into `nextItems`.
