---
"@e2b/ai-sdk-sandbox": patch
---

Fix the release pipeline so a successful publish no longer reports failure.

The package script was named `publish`, which npm treats as a lifecycle hook and
runs after a successful `npm publish`. That re-entered `changeset publish`, and the
nested attempt raced registry propagation: if the just-published version was not yet
visible it tried to publish it again and failed with "cannot publish over the
previously published versions", turning a completed release into a red run with the
version bump commit skipped. The script is now named `release`, so nothing re-enters.

No runtime code changed; the published module is identical to 0.2.0.
