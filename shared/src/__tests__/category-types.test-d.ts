// Pure compile-time contract test for the `Category` classification type and
// the `Stats` counts that mirror it.
//
// This is a `.test-d.ts` file (NOT a `.test.ts` file): the root Vitest config
// only includes the shared test glob (see root vitest.config), so this file
// is never executed. It is type-checked by `pnpm --filter @pigeon/shared
// typecheck` because `shared/tsconfig.json` has `include: ["src"]`. No
// `vitest` import, no runtime, no `describe`/`it` — just assignments and
// `@ts-expect-error` directives that prove the renamed type has exactly the
// required shape.

import type { Category, Stats } from "../index";

// Category — the three new classification literals.
const _categoryRequiresAction: Category = "requires_action";
const _categoryImportant: Category = "important";
const _categoryNoise: Category = "noise";

// @ts-expect-error "urgent" is an old literal and must no longer be a Category
const _categoryOldUrgent: Category = "urgent";

// @ts-expect-error "everything" is an old literal and must no longer be a Category
const _categoryOldEverything: Category = "everything";

// Stats — exactly requires_action / important / noise, all numbers.
const _statsComplete: Stats = {
  requires_action: 3,
  important: 2,
  noise: 1,
};

// @ts-expect-error Stats must use the new keys, not the old urgent/everything keys
const _statsOldKeys: Stats = { urgent: 3, important: 2, everything: 1 };
