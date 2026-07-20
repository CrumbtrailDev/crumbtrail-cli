# Model resolution and effort table

Requested by the deep-build skill: a current GPT-family model.
Enumerated runtime: Claude Code agent runner, models `opus` | `sonnet` | `haiku` | `fable`.
No GPT-family model resolves in this runtime.

FALLBACK APPLIED: uniform Claude model selection (`opus`), effort varied by role.
This is a reported fallback, not a silent substitution.

| Role | Model | Effort |
| --- | --- | --- |
| Checkpoint Planner | opus | high |
| Checkpoint Builder | opus | medium (high for CP2, security-sensitive) |
| Checkpoint Reviewers (round 1, dual lens) | opus | high |
| Revision Builder | opus | matches its builder |
| Scope Drift / Code Quality auditors | opus | medium |
| Security auditor | opus | high |
| Copy auditor + copy implementer | haiku | low |
