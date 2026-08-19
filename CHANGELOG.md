# @e2b/ai-sdk-sandbox

## 0.2.0

### Minor Changes

- 0c4c040: Update dependencies and add SDK integration attribution.

  - Bump `e2b` to `^2.35.0`, `@ai-sdk/harness` to `^1.0.39`, and `@ai-sdk/provider-utils` to `^5.0.12`.
  - Tag requests to E2B with an integration `User-Agent` (`e2b-ai-sdk-sandbox/<version>`) via `ConnectionConfig.setIntegration`, so E2B can attribute traffic from this provider. The version is derived from `package.json`.
  - Look snapshots up with the server-side `name` filter (e2b 2.34+) instead of paging through every team snapshot, and simplify the list-paginator calls (`listSnapshots`/`list`) to rely on the connection options captured at construction rather than re-passing them into `nextItems`.
