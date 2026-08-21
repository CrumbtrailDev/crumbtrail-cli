// The trigger for the misclassification this fixture guards against: Nuxt 3
// recognises a ROOT-level app/ directory for router options, while its plugins
// still come from the repo-root plugins/. A bare `app/` existence probe reads
// this project as Nuxt 4 and writes app/plugins/crumbtrail.client.ts, which
// Nuxt 3 never scans — a silent zero capture behind a green "wired in" line.
//
// Router options are the one thing Nuxt 3 does read out of a root-level app/,
// which is why a real Nuxt 3 project can have this directory at all. Declaring
// them turns the router on, so this fixture ships a root-level pages/index.vue
// for the router to resolve.
import type { RouterConfig } from "@nuxt/schema";

export default <RouterConfig>{};
