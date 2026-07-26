import { describe, expect, it } from "vitest";
import {
  DEFAULT_REPLAY_MAX_STEPS,
  DEFAULT_REPLAY_STEP_TIMEOUT_MS,
  defaultReplayPolicy,
  describeRefusal,
  evaluateReplayPolicy,
  replayPolicyFromEnv,
  resolveReplayPolicy,
  type ReplayPolicy,
} from "../replay/policy";
import type { ReplayFlow, ReplayStep } from "../replay/types";

const TARGET = "http://localhost:4173";

function step(overrides: Partial<ReplayStep> = {}): ReplayStep {
  return {
    index: 0,
    sig: "sig-1",
    action: "click",
    selector: "#go",
    tag: "button",
    role: "button",
    label: "Go",
    ...overrides,
  };
}

function flow(overrides: Partial<ReplayFlow> = {}): ReplayFlow {
  return {
    sourceSessionId: "ses_src_001",
    targetUrl: TARGET,
    steps: [step()],
    ...overrides,
  };
}

/** Everything permitted: the only configuration that reaches `execute`. */
function permissivePolicy(overrides: Partial<ReplayPolicy> = {}): ReplayPolicy {
  return resolveReplayPolicy({
    execute: true,
    allowlist: [{ origin: TARGET, isolated: true }],
    ...overrides,
  });
}

describe("defaultReplayPolicy", () => {
  it("is observation only with nothing allowlisted", () => {
    expect(defaultReplayPolicy()).toEqual({
      execute: false,
      allowlist: [],
      maxSteps: DEFAULT_REPLAY_MAX_STEPS,
      stepTimeoutMs: DEFAULT_REPLAY_STEP_TIMEOUT_MS,
    });
  });

  it("resolveReplayPolicy keeps defaults for omitted fields", () => {
    expect(resolveReplayPolicy({ execute: true })).toEqual({
      execute: true,
      allowlist: [],
      maxSteps: DEFAULT_REPLAY_MAX_STEPS,
      stepTimeoutMs: DEFAULT_REPLAY_STEP_TIMEOUT_MS,
    });
  });

  it("resolveReplayPolicy ignores explicitly undefined overrides", () => {
    expect(resolveReplayPolicy({ execute: undefined }).execute).toBe(false);
  });
});

describe("evaluateReplayPolicy — observation only by default", () => {
  it("refuses with reproduction_not_requested when the caller does not opt in", () => {
    const decision = evaluateReplayPolicy(flow(), permissivePolicy());

    expect(decision.mode).toBe("observe");
    expect(decision.eligible).toBe(true);
    expect(decision.refusal?.code).toBe("reproduction_not_requested");
    expect(decision.refusal?.remedy).toContain("allowReproduction");
  });

  it("refuses a non-true allowReproduction value", () => {
    for (const allowReproduction of [
      undefined,
      false,
      "true" as unknown as boolean,
      1 as unknown as boolean,
    ]) {
      const decision = evaluateReplayPolicy(flow(), permissivePolicy(), {
        allowReproduction,
      });
      expect(decision.mode).toBe("observe");
      expect(decision.refusal?.code).toBe("reproduction_not_requested");
    }
  });

  it("refuses with execution_not_enabled when the environment has not opted in", () => {
    const decision = evaluateReplayPolicy(
      flow(),
      resolveReplayPolicy({
        allowlist: [{ origin: TARGET, isolated: true }],
      }),
      { allowReproduction: true },
    );

    expect(decision.mode).toBe("observe");
    expect(decision.eligible).toBe(true);
    expect(decision.refusal?.code).toBe("execution_not_enabled");
  });

  it("refuses with the bare default policy even when reproduction is requested", () => {
    const decision = evaluateReplayPolicy(flow(), defaultReplayPolicy(), {
      allowReproduction: true,
    });

    expect(decision.mode).toBe("observe");
    expect(decision.refusal?.code).toBe("execution_not_enabled");
  });
});

describe("evaluateReplayPolicy — allowlist is required to execute", () => {
  it("permits execution for an allowlisted isolated origin", () => {
    const decision = evaluateReplayPolicy(flow(), permissivePolicy(), {
      allowReproduction: true,
    });

    expect(decision).toEqual({
      eligible: true,
      mode: "execute",
      targetOrigin: "http://localhost:4173",
    });
  });

  it("refuses an origin that is not on the allowlist", () => {
    const decision = evaluateReplayPolicy(
      flow({ targetUrl: "https://staging.example.com/" }),
      permissivePolicy(),
      { allowReproduction: true },
    );

    expect(decision.mode).toBe("observe");
    expect(decision.refusal?.code).toBe("target_not_allowlisted");
    expect(decision.refusal?.reason).toContain("https://staging.example.com");
  });

  it("refuses an allowlisted origin that is not declared isolated", () => {
    const decision = evaluateReplayPolicy(
      flow(),
      permissivePolicy({ allowlist: [{ origin: TARGET, isolated: false }] }),
      { allowReproduction: true },
    );

    expect(decision.mode).toBe("observe");
    expect(decision.refusal?.code).toBe("target_not_isolated");
    expect(decision.refusal?.reason).toContain("mutate data it must not touch");
  });

  it("matches the allowlist on origin, ignoring path and trailing slash", () => {
    const decision = evaluateReplayPolicy(
      flow({ targetUrl: `${TARGET}/checkout` }),
      permissivePolicy({
        allowlist: [{ origin: `${TARGET}/`, isolated: true }],
      }),
      { allowReproduction: true },
    );

    expect(decision.mode).toBe("execute");
  });

  it("does not treat a different port as the same origin", () => {
    const decision = evaluateReplayPolicy(
      flow({ targetUrl: "http://localhost:4174" }),
      permissivePolicy(),
      { allowReproduction: true },
    );

    expect(decision.refusal?.code).toBe("target_not_allowlisted");
  });

  it("refuses a target URL carrying embedded credentials", () => {
    const decision = evaluateReplayPolicy(
      flow({ targetUrl: "http://admin:secret@localhost:4173" }),
      permissivePolicy(),
      { allowReproduction: true },
    );

    expect(decision.eligible).toBe(false);
    expect(decision.refusal?.code).toBe("target_url_invalid");
  });
});

describe("evaluateReplayPolicy — ineligible flows explain themselves", () => {
  it("refuses an empty flow", () => {
    const decision = evaluateReplayPolicy(
      flow({ steps: [] }),
      permissivePolicy(),
      {
        allowReproduction: true,
      },
    );

    expect(decision.eligible).toBe(false);
    expect(decision.refusal?.code).toBe("no_replayable_steps");
    expect(decision.refusal?.reason).toBeTruthy();
    expect(decision.refusal?.remedy).toBeTruthy();
  });

  it("refuses a non-http target", () => {
    for (const targetUrl of ["", "   ", "file:///tmp/app", "not a url"]) {
      const decision = evaluateReplayPolicy(
        flow({ targetUrl }),
        permissivePolicy(),
        { allowReproduction: true },
      );
      expect(decision.eligible).toBe(false);
      expect(decision.refusal?.code).toBe("target_url_invalid");
    }
  });

  it("refuses a flow above the step budget", () => {
    const steps = Array.from({ length: 4 }, (_, index) =>
      step({ index, sig: `sig-${index}` }),
    );
    const decision = evaluateReplayPolicy(
      flow({ steps }),
      permissivePolicy({ maxSteps: 3 }),
      { allowReproduction: true },
    );

    expect(decision.eligible).toBe(false);
    expect(decision.refusal?.code).toBe("step_budget_exceeded");
    expect(decision.refusal?.reason).toContain("4 steps");
  });

  it("every refusal carries a code and a non-empty reason", () => {
    const cases: Array<[ReplayFlow, ReplayPolicy, boolean]> = [
      [flow({ steps: [] }), permissivePolicy(), true],
      [flow({ targetUrl: "ftp://x" }), permissivePolicy(), true],
      [flow(), permissivePolicy({ maxSteps: 0 }), true],
      [
        flow({
          steps: [
            step({
              action: "input",
              value: { kind: "secret", reason: "field is credential-like" },
            }),
          ],
        }),
        permissivePolicy(),
        true,
      ],
      [flow(), permissivePolicy(), false],
      [flow(), resolveReplayPolicy({}), true],
      [flow({ targetUrl: "https://elsewhere.test" }), permissivePolicy(), true],
      [
        flow(),
        permissivePolicy({ allowlist: [{ origin: TARGET, isolated: false }] }),
        true,
      ],
    ];

    const codes = cases.map(([f, p, allow]) => {
      const decision = evaluateReplayPolicy(f, p, {
        allowReproduction: allow,
      });
      expect(decision.mode).toBe("observe");
      expect(decision.refusal?.reason.length).toBeGreaterThan(0);
      return decision.refusal?.code;
    });

    expect(codes).toEqual([
      "no_replayable_steps",
      "target_url_invalid",
      "step_budget_exceeded",
      "flow_carries_secret",
      "reproduction_not_requested",
      "execution_not_enabled",
      "target_not_allowlisted",
      "target_not_isolated",
    ]);
  });
});

describe("evaluateReplayPolicy — secrets", () => {
  it("refuses a flow whose step depends on a credential-like value", () => {
    const decision = evaluateReplayPolicy(
      flow({
        steps: [
          step({
            index: 0,
            sig: "s-pw",
            action: "input",
            value: {
              kind: "secret",
              reason: 'field "password" is credential-like',
            },
          }),
        ],
      }),
      permissivePolicy(),
      { allowReproduction: true },
    );

    expect(decision.eligible).toBe(false);
    expect(decision.mode).toBe("observe");
    expect(decision.refusal?.code).toBe("flow_carries_secret");
    expect(decision.refusal?.reason).toContain("s-pw");
    expect(decision.refusal?.reason).toContain("never forwarded");
  });

  it("permits a flow whose input value was redacted at capture", () => {
    const decision = evaluateReplayPolicy(
      flow({
        steps: [step({ action: "input", value: { kind: "redacted" } })],
      }),
      permissivePolicy(),
      { allowReproduction: true },
    );

    expect(decision.mode).toBe("execute");
  });

  it("refuses a secret-bearing flow before it checks the opt-in", () => {
    const decision = evaluateReplayPolicy(
      flow({
        steps: [
          step({
            action: "input",
            value: { kind: "secret", reason: "token-like" },
          }),
        ],
      }),
      defaultReplayPolicy(),
    );

    expect(decision.refusal?.code).toBe("flow_carries_secret");
  });
});

describe("replayPolicyFromEnv", () => {
  it("is observation only for an empty environment", () => {
    expect(replayPolicyFromEnv({})).toEqual(defaultReplayPolicy());
  });

  it("requires both the execute flag and an isolated origin", () => {
    expect(
      replayPolicyFromEnv({ CRUMBTRAIL_REPLAY_EXECUTE: "1" }),
    ).toMatchObject({
      execute: true,
      allowlist: [],
    });
    expect(
      replayPolicyFromEnv({
        CRUMBTRAIL_REPLAY_ISOLATED_ORIGINS: TARGET,
      }),
    ).toMatchObject({
      execute: false,
      allowlist: [{ origin: TARGET, isolated: true }],
    });
  });

  it("only accepts 1 or true for the execute flag", () => {
    for (const value of ["0", "false", "yes", "TRUE ", "", "on"]) {
      const expected = value.trim().toLowerCase() === "true";
      expect(
        replayPolicyFromEnv({ CRUMBTRAIL_REPLAY_EXECUTE: value }).execute,
      ).toBe(expected);
    }
  });

  it("parses, de-duplicates and normalizes the isolated origin list", () => {
    const policy = replayPolicyFromEnv({
      CRUMBTRAIL_REPLAY_ISOLATED_ORIGINS: `${TARGET}, ${TARGET}/ , https://qa.example.com`,
    });

    expect(policy.allowlist).toEqual([
      { origin: "http://localhost:4173", isolated: true },
      { origin: "https://qa.example.com", isolated: true },
    ]);
  });

  it("drops malformed and non-http origins instead of widening the allowlist", () => {
    const policy = replayPolicyFromEnv({
      CRUMBTRAIL_REPLAY_ISOLATED_ORIGINS:
        "not-a-url, file:///tmp, http://user:pw@host, https://ok.example.com",
    });

    expect(policy.allowlist).toEqual([
      { origin: "https://ok.example.com", isolated: true },
    ]);
  });

  it("accepts positive integer budget overrides only", () => {
    expect(
      replayPolicyFromEnv({
        CRUMBTRAIL_REPLAY_MAX_STEPS: "12",
        CRUMBTRAIL_REPLAY_STEP_TIMEOUT_MS: "250",
      }),
    ).toMatchObject({ maxSteps: 12, stepTimeoutMs: 250 });

    expect(
      replayPolicyFromEnv({
        CRUMBTRAIL_REPLAY_MAX_STEPS: "0",
        CRUMBTRAIL_REPLAY_STEP_TIMEOUT_MS: "-5",
      }),
    ).toMatchObject({
      maxSteps: DEFAULT_REPLAY_MAX_STEPS,
      stepTimeoutMs: DEFAULT_REPLAY_STEP_TIMEOUT_MS,
    });
  });
});

describe("describeRefusal", () => {
  it("includes the remedy when there is one", () => {
    expect(
      describeRefusal({
        code: "driver_unavailable",
        reason: "a.",
        remedy: "b.",
      }),
    ).toBe("driver_unavailable: a. b.");
    expect(describeRefusal({ code: "driver_unavailable", reason: "a." })).toBe(
      "driver_unavailable: a.",
    );
  });
});
