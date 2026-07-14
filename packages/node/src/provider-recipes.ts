import recipes from "./provider-recipes.json";

export type ProviderId = "datadog" | "otel" | "sentry" | "grafana" | "splunk";

export interface ProviderRecipe {
  id: ProviderId;
  title: string;
  docFile: string;
  description: string;
  config: string;
  notes: string[];
}

export const PROVIDER_RECIPES = recipes as ProviderRecipe[];
export const PROVIDER_IDS = PROVIDER_RECIPES.map(
  (recipe) => recipe.id,
) as ProviderId[];

const DEFAULT_ENDPOINT = "http://127.0.0.1:9898";

export function isProviderId(value: string | undefined): value is ProviderId {
  return PROVIDER_RECIPES.some((recipe) => recipe.id === value);
}

export function getProviderRecipe(provider: ProviderId): ProviderRecipe {
  const recipe = PROVIDER_RECIPES.find((entry) => entry.id === provider);
  if (!recipe) throw new Error(`unknown provider ${provider}`);
  return recipe;
}

export function renderProviderConfig(
  provider: ProviderId,
  endpoint = DEFAULT_ENDPOINT,
): string {
  return getProviderRecipe(provider).config.replaceAll(
    "{{endpoint}}",
    endpoint,
  );
}

export function renderProviderCliOutput(
  provider: ProviderId,
  endpoint = DEFAULT_ENDPOINT,
): string {
  const recipe = getProviderRecipe(provider);
  return [
    `# ${recipe.title} -> Crumbtrail`,
    "",
    recipe.description,
    "",
    "```yaml",
    renderProviderConfig(provider, endpoint),
    "```",
    "",
    ...recipe.notes.map((note) => `- ${note}`),
    "",
    "Run `crumbtrail-server doctor --port 9898` after the first payload to confirm Crumbtrail received telemetry.",
    "",
  ].join("\n");
}

export function renderProviderDoc(
  provider: ProviderId,
  endpoint = DEFAULT_ENDPOINT,
): string {
  const recipe = getProviderRecipe(provider);
  return [
    `# ${recipe.title} -> Crumbtrail`,
    "",
    recipe.description,
    "",
    "```yaml",
    renderProviderConfig(provider, endpoint),
    "```",
    "",
    "## Verify",
    "",
    "Start Crumbtrail locally, send one payload, then run:",
    "",
    "```bash",
    "crumbtrail-server doctor --port 9898",
    "```",
    "",
    "Doctor should report the first OTLP payload, including received span count, service name, and created session id.",
    "",
    "## Notes",
    "",
    ...recipe.notes.map((note) => `- ${note}`),
    "",
    "- Crumbtrail accepts sessionless OTLP and auto-creates sessions from service/version/environment attributes.",
    "- Add `crumbtrail.session.id` later when you want strict frontend/backend session joins.",
    "",
  ].join("\n");
}

export function renderProviderReadme(): string {
  const rows = PROVIDER_RECIPES.map(
    (recipe) =>
      `| ${recipe.title} | [${recipe.docFile}](./${recipe.docFile}) |`,
  );
  return [
    "# Plug your telemetry into Crumbtrail",
    "",
    "Crumbtrail ingests standard OTLP/HTTP (`/v1/traces`, `/v1/logs`) and maps it into its AI-readable, ranked bug bundle.",
    "Anything that exports OpenTelemetry can feed Crumbtrail: add it as a second exporter and keep your existing provider.",
    "",
    "Sessionless spans and logs are accepted. Crumbtrail auto-creates time-window sessions from service metadata, then upgrades cleanly when you add `crumbtrail.session.id`.",
    "",
    "| Source | Recipe |",
    "|---|---|",
    ...rows,
    "",
  ].join("\n");
}
