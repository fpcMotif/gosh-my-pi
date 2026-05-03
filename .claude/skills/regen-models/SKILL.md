---
name: regen-models
description: Regenerate `packages/ai/src/models.json` after changing a provider descriptor or resolver. ALWAYS use this instead of editing models.json by hand. Trigger on "regen models", "/regen-models", "regenerate models.json", "update model list".
---

Run `bun --cwd=packages/ai run generate-models`.

This script reads provider descriptors and the resolvers in `packages/ai/src/provider-models/` (e.g., `openai-compat.ts`) and rewrites `packages/ai/src/models.json`.

**Hand-editing `packages/ai/src/models.json` is forbidden** — your changes get clobbered the next time anyone regenerates. If the regenerated output is wrong, fix the resolver or the descriptor, then re-run this skill.

After running:

1. `git diff packages/ai/src/models.json` — confirm the intended change landed and no unrelated entries regressed.
2. If providers were added/removed, double-check `packages/ai/src/providers/` is in sync.

**Important history note**: `anthropic`/Claude was removed as a provider in commit `2da77ade7`. Do NOT re-add Claude provider files or descriptors unless the user explicitly asks for it.
