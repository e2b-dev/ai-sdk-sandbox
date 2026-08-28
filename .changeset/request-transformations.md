---
"@e2b/ai-sdk-sandbox": minor
---

Implement `setRequestTransformations` / `addRequestTransformations` on the E2B network sandbox session, mapping harness request transformations to E2B per-host egress transform rules. Harness adapters (e.g. `@ai-sdk/harness-claude-code`) now broker credentials at the egress proxy instead of forwarding real API keys into the sandbox. `setNetworkPolicy` preserves the creation-time network baseline and managed transformation rules on every update. Fixes #5.
