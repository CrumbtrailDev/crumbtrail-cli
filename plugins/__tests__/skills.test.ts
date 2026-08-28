/**
 * The skills gate.
 *
 * A skill file is an instruction sheet an agent follows literally, so a
 * malformed one costs an agent a turn and leaves it with a wrong model of the
 * API. That is worse than shipping no skill at all, so this is a gate rather
 * than a lint warning.
 *
 * Every `SKILL.md` under Crumbtrail's own `plugins/crumbtrail-*` directories,
 * plus the `REFERENCE-SKILL.md` template, is checked for frontmatter, the five
 * required sections in order, and at least one parseable declared call.
 * Discovery is scoped to those directories rather than all of `plugins/`,
 * because `plugins/` is also where a developer's locally installed third party
 * plugins land (see `.gitignore`) and those are not ours to check.
 *
 * What this gate NO LONGER checks: that each declared `tool` name and its
 * parameters exist. That half read the live table off a local `McpServer`,
 * which left this repository when `crumbtrail-node` became backend capture
 * only. Crumbtrail's MCP server is hosted now, so the tool-accuracy half of
 * this gate belongs beside it rather than here. Until it is rebuilt there, a
 * skill naming a tool that does not exist passes this file.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PLUGINS_DIR = path.join(REPO_ROOT, "plugins");

/** The five sections every archetype skill carries, in this order. */
const REQUIRED_SECTIONS = [
  "Symptom",
  "What Crumbtrail can see",
  "Call sequence",
  "Telling it apart",
  "What a null result means",
] as const;

const REQUIRED_FRONTMATTER = ["name", "description"] as const;

// ---------------------------------------------------------------------------
// The live tool table
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Markdown parsing
// ---------------------------------------------------------------------------

interface Fence {
  lang: string;
  body: string;
}

const FENCE_RE = /^```([A-Za-z0-9_-]*)[ \t]*\n([\s\S]*?)^```[ \t]*$/gm;

function collectFences(source: string): Fence[] {
  const fences: Fence[] = [];
  for (const match of source.matchAll(FENCE_RE)) {
    fences.push({ lang: match[1].toLowerCase(), body: match[2] });
  }
  return fences;
}

function stripFences(source: string): string {
  return source.replace(FENCE_RE, "");
}

/**
 * Deliberately a small subset of YAML: `key: value` at the top level, with
 * optional surrounding quotes. Skill frontmatter is flat by convention, and a
 * real YAML dependency for two keys is not worth carrying.
 */
function parseFrontmatter(source: string): Record<string, string> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);
  if (!match) return undefined;
  const out: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    out[kv[1]] = kv[2].trim().replace(/^["'](.*)["']$/, "$1");
  }
  return out;
}

function collectHeadings(source: string): string[] {
  return [...stripFences(source).matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------
// Tool reference extraction
// ---------------------------------------------------------------------------

interface DeclaredCall {
  tool: unknown;
  params?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Call sequences are declared as `json` fenced blocks holding one call object
 * or an array of them. Any `json` block must parse; only blocks carrying a
 * `tool` key are treated as calls.
 */
function extractDeclaredCalls(
  fences: Fence[],
  errors: string[],
): DeclaredCall[] {
  const calls: DeclaredCall[] = [];
  fences.forEach((fence, i) => {
    if (fence.lang !== "json") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fence.body);
    } catch (cause) {
      errors.push(
        `json fenced block #${i + 1} does not parse: ${(cause as Error).message}`,
      );
      return;
    }
    for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
      if (isRecord(entry) && "tool" in entry) calls.push(entry as DeclaredCall);
    }
  });
  return calls;
}

// ---------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------

interface SkillSource {
  /** Repo relative path, used only in failure messages. */
  relPath: string;
  /** Directory name the skill lives in. */
  dirName: string;
  source: string;
}

/**
 * Returns one string per problem. Empty means the skill is well formed.
 * Pure: takes the text, touches no disk.
 */
function validateSkill(skill: SkillSource): string[] {
  const errors: string[] = [];
  const fail = (message: string) => errors.push(`${skill.relPath}: ${message}`);

  // --- frontmatter -------------------------------------------------------
  const frontmatter = parseFrontmatter(skill.source);
  if (!frontmatter) {
    fail("missing YAML frontmatter delimited by --- on the first line");
  } else {
    for (const key of REQUIRED_FRONTMATTER) {
      if (!frontmatter[key]?.trim()) fail(`frontmatter is missing "${key}"`);
    }
    const expectedName = skill.dirName;
    if (frontmatter.name && frontmatter.name !== expectedName) {
      fail(
        `frontmatter name "${frontmatter.name}" does not match its directory "${skill.dirName}" (expected "${expectedName}")`,
      );
    }
    if (frontmatter.name && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(frontmatter.name)) {
      fail(
        `frontmatter name "${frontmatter.name}" must be lowercase kebab case, which is what Claude Code accepts as a skill name`,
      );
    }
    if (frontmatter.description && frontmatter.description.length > 1024) {
      fail(
        `frontmatter description is ${frontmatter.description.length} characters; keep it under 1024 so it survives the skill listing`,
      );
    }
  }

  // --- section shape -----------------------------------------------------
  const headings = collectHeadings(skill.source);
  let cursor = -1;
  for (const section of REQUIRED_SECTIONS) {
    const at = headings.indexOf(section, cursor + 1);
    if (at === -1) {
      fail(
        `missing required section "## ${section}". The five sections, in order, are: ${REQUIRED_SECTIONS.map((s) => `## ${s}`).join(" | ")}`,
      );
    } else {
      cursor = at;
    }
  }

  // --- declared call sequences -------------------------------------------
  const blockErrors: string[] = [];
  const calls = extractDeclaredCalls(collectFences(skill.source), blockErrors);
  blockErrors.forEach(fail);

  if (calls.length === 0) {
    fail(
      'declares no calls. A skill must carry at least one json fenced block shaped {"tool": "...", "params": {...}}, otherwise it is advice rather than a procedure.',
    );
  }

  for (const call of calls) {
    if (typeof call.tool !== "string" || !call.tool.trim()) {
      fail(`a declared call has a non string "tool"`);
      continue;
    }
    if (call.params !== undefined && !isRecord(call.params)) {
      fail(`calls "${call.tool}" with a non object "params"`);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Crumbtrail's own plugin directories. `plugins/` is ignored wholesale in
 * `.gitignore` because it is also where locally installed third party plugins
 * land, so a developer machine can hold directories this repository does not
 * publish. Enumerating all of `plugins/` would validate a stranger's SKILL.md
 * against Crumbtrail's tool table and break the marketplace set equality below,
 * and only on developer machines — CI, with its clean checkout, would stay
 * green. The `crumbtrail-` prefix is the boundary.
 */
const OWN_PLUGIN_PREFIX = "crumbtrail-";

function ownPluginDirs(): string[] {
  return fs
    .readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(OWN_PLUGIN_PREFIX))
    .map((e) => e.name);
}

/**
 * The archetype template. It is held outside `skills/` so no loader installs it
 * as a thirteenth skill, which means discovery has to name it explicitly. Its
 * frontmatter `name` is checked against this, since it has no directory of its
 * own any more.
 */
const REFERENCE_TEMPLATE = {
  file: path.join(PLUGINS_DIR, "crumbtrail-skills", "REFERENCE-SKILL.md"),
  name: "reference",
};

function findSkillFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findSkillFiles(full, out);
    else if (entry.name === "SKILL.md") out.push(full);
  }
  return out;
}

function loadSkills(): SkillSource[] {
  const skills = ownPluginDirs()
    .flatMap((name) => findSkillFiles(path.join(PLUGINS_DIR, name)))
    .map((file) => ({
      relPath: path.relative(REPO_ROOT, file),
      dirName: path.basename(path.dirname(file)),
      source: fs.readFileSync(file, "utf8"),
    }));

  skills.push({
    relPath: path.relative(REPO_ROOT, REFERENCE_TEMPLATE.file),
    dirName: REFERENCE_TEMPLATE.name,
    source: fs.readFileSync(REFERENCE_TEMPLATE.file, "utf8"),
  });

  return skills;
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe("skills gate", () => {
  it("finds at least one skill to check", () => {
    expect(loadSkills().length).toBeGreaterThan(0);
  });

  it("every SKILL.md is well formed", () => {
    const problems = loadSkills().flatMap((skill) => validateSkill(skill));
    expect(problems).toEqual([]);
  });

  it("installs twelve archetypes and keeps the template out of skills/", () => {
    // A loader installs whatever carries a SKILL.md under `skills/`. The
    // template says in its own description that it diagnoses nothing, but that
    // is a mitigation, not a boundary — the boundary is that it is not there.
    const skillsDir = path.join(PLUGINS_DIR, "crumbtrail-skills", "skills");
    const installed = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(installed).toHaveLength(12);
    expect(installed.some((name) => name.startsWith("_"))).toBe(false);
    expect(fs.existsSync(REFERENCE_TEMPLATE.file)).toBe(true);
  });

  it("ignores a third party plugin a developer installed into plugins/", () => {
    // `plugins/` is ignored wholesale in .gitignore precisely because local
    // installs land there. Enumerating all of it validated a stranger's skill
    // against our tool table, and only ever failed on a developer's machine.
    const intruder = fs.mkdtempSync(path.join(PLUGINS_DIR, "third-party-"));
    try {
      fs.mkdirSync(path.join(intruder, "skills", "someone-elses"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(intruder, "skills", "someone-elses", "SKILL.md"),
        "---\nname: someone-elses\n---\n\nCall theirFabricatedTool.\n",
      );

      const loaded = loadSkills();
      const stranger = path.basename(intruder);
      expect(loaded.map((s) => s.relPath).join("\n")).not.toContain(stranger);
      expect(
        loaded.flatMap((s) => validateSkill(s)).join("\n"),
      ).not.toContain(stranger);
      expect(ownPluginDirs()).not.toContain(stranger);
    } finally {
      fs.rmSync(intruder, { recursive: true, force: true });
    }
  });
});

describe("skills gate refusals", () => {
  const shell = (body: string, name = "sample") => ({
    relPath: `plugins/crumbtrail-skills/skills/${name}/SKILL.md`,
    dirName: name,
    source: [
      "---",
      `name: ${name}`,
      "description: A fixture used only by the gate's own refusal tests.",
      "---",
      "",
      ...REQUIRED_SECTIONS.map((s) => `## ${s}\n\nBody.\n`),
      body,
    ].join("\n"),
  });

  const callBlock = (json: string) => ["```json", json, "```"].join("\n");

  it("passes a well formed fixture, so the refusals below mean something", () => {
    const ok = shell(
      callBlock('{ "tool": "getWindow", "params": { "sessionId": "s", "t0": 1, "t1": 2 } }'),
    );
    expect(validateSkill(ok)).toEqual([]);
  });

  it("refuses a skill that declares no calls at all", () => {
    const skill = shell("Just some advice, no queries.");
    expect(validateSkill(skill).join("\n")).toContain("declares no calls");
  });

  it("refuses a missing section", () => {
    const skill = {
      relPath: "plugins/crumbtrail-skills/skills/sample/SKILL.md",
      dirName: "sample",
      source: [
        "---",
        "name: sample",
        "description: Fixture.",
        "---",
        "",
        "## Symptom",
        "",
        callBlock('{ "tool": "listSessions" }'),
      ].join("\n"),
    };
    expect(validateSkill(skill).join("\n")).toContain(
      'missing required section "## What Crumbtrail can see"',
    );
  });

  it("refuses sections that are present but out of order", () => {
    const reordered = [REQUIRED_SECTIONS[1], REQUIRED_SECTIONS[0], ...REQUIRED_SECTIONS.slice(2)];
    const skill = {
      relPath: "plugins/crumbtrail-skills/skills/sample/SKILL.md",
      dirName: "sample",
      source: [
        "---",
        "name: sample",
        "description: Fixture.",
        "---",
        "",
        ...reordered.map((s) => `## ${s}\n\nBody.\n`),
        callBlock('{ "tool": "listSessions" }'),
      ].join("\n"),
    };
    // Order is checked by scanning forward, so the section that is now out of
    // reach is the one reported, not the one that moved.
    expect(validateSkill(skill).join("\n")).toContain(
      'missing required section "## What Crumbtrail can see"',
    );
  });

  it("refuses frontmatter that disagrees with the directory name", () => {
    const skill = {
      ...shell(callBlock('{ "tool": "listSessions" }'), "sample"),
      dirName: "other-name",
    };
    expect(validateSkill(skill).join("\n")).toContain(
      'does not match its directory "other-name"',
    );
  });

  it("refuses missing frontmatter", () => {
    const skill = {
      relPath: "plugins/crumbtrail-skills/skills/sample/SKILL.md",
      dirName: "sample",
      source: [
        ...REQUIRED_SECTIONS.map((s) => `## ${s}\n\nBody.\n`),
        callBlock('{ "tool": "listSessions" }'),
      ].join("\n"),
    };
    expect(validateSkill(skill).join("\n")).toContain("missing YAML frontmatter");
  });

  it("refuses a json block that does not parse", () => {
    const skill = shell(
      [callBlock('{ "tool": "listSessions" }'), callBlock("{ nope }")].join("\n\n"),
    );
    expect(validateSkill(skill).join("\n")).toContain("does not parse");
  });

});

describe("plugin manifests", () => {
  const pluginDirs = ownPluginDirs();

  it("has at least one plugin", () => {
    expect(pluginDirs.length).toBeGreaterThan(0);
  });

  it.each(pluginDirs)("%s has a valid Claude Code plugin manifest", (name) => {
    const manifest = readJson(
      path.join(PLUGINS_DIR, name, ".claude-plugin", "plugin.json"),
    );
    expect(manifest.$schema).toBe(
      "https://json.schemastore.org/claude-code-plugin-manifest.json",
    );
    expect(manifest.name).toBe(name);
    expect(typeof manifest.description).toBe("string");
    expect(manifest.description.length).toBeGreaterThan(0);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof manifest.author?.name).toBe("string");
    expect(typeof manifest.license).toBe("string");
    expect(Array.isArray(manifest.keywords)).toBe(true);
  });

  it.each(pluginDirs)(
    "%s keeps its vendor neutral .plugin manifest in sync",
    (name) => {
      const vendorNeutral = path.join(PLUGINS_DIR, name, ".plugin", "plugin.json");
      if (!fs.existsSync(vendorNeutral)) return;
      const claude = readJson(
        path.join(PLUGINS_DIR, name, ".claude-plugin", "plugin.json"),
      );
      delete claude.$schema;
      expect(readJson(vendorNeutral)).toEqual(claude);
    },
  );

  it("lists every plugin in the marketplace, and lists nothing that is missing", () => {
    const marketplace = readJson(
      path.join(REPO_ROOT, ".claude-plugin", "marketplace.json"),
    );
    expect(marketplace.$schema).toBe(
      "https://json.schemastore.org/claude-code-marketplace.json",
    );
    expect(typeof marketplace.name).toBe("string");
    expect(typeof marketplace.owner?.name).toBe("string");
    expect(Array.isArray(marketplace.plugins)).toBe(true);

    for (const entry of marketplace.plugins) {
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.source).toBe("string");
      const dir = path.join(REPO_ROOT, entry.source);
      expect(fs.existsSync(dir)).toBe(true);
      expect(
        readJson(path.join(dir, ".claude-plugin", "plugin.json")).name,
      ).toBe(entry.name);
    }

    expect(marketplace.plugins.map((p: any) => p.name).sort()).toEqual(
      [...pluginDirs].sort(),
    );
  });
});
