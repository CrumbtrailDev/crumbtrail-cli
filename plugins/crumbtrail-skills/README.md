# crumbtrail-skills

Failure archetype skills for Crumbtrail. Each skill takes one recurring failure shape and pairs it with the exact Crumbtrail MCP calls that confirm or rule it out, so an agent troubleshoots against a recorded session rather than a generic checklist.

Install the `crumbtrail-mcp` plugin alongside this one. These skills are instructions for driving that server, so on their own they have nothing to query.

## Skill shape

Every skill in `skills/` uses the same five sections, in this order:

1. `## Symptom`: what the reporter or the failing test actually saw.
2. `## What Crumbtrail can see`: which signals exist for this archetype, and which do not. Say plainly when a signal is missing.
3. `## Call sequence`: the calls to run, as `json` fenced blocks of `{"tool": ..., "params": {...}}`.
4. `## Telling it apart`: how to separate this archetype from the ones it resembles.
5. `## What a null result means`: what an empty answer rules out, and what it does not.

`skills/_reference/SKILL.md` is the worked example. Read it before adding a skill. The leading underscore marks it as a template rather than an archetype, and its frontmatter `name` drops that underscore.

## The gate

`plugins/__tests__/skills.test.ts` validates every `SKILL.md` under `plugins/` against the live MCP tool table, read the same way the hosted dispatch reads it: it constructs an `McpServer` and calls `tools/list`. A skill that names a tool which does not exist, or passes a parameter a tool does not accept, fails the suite.

```bash
pnpm test:plugins
```

A skill that names a nonexistent tool costs an agent a whole turn and teaches it a wrong API, which is why this is a gate and not a lint warning.
