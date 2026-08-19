/**
 * Tests for the OpenCode plugin's agent-mode header (plugin/meridian.ts).
 *
 * OpenCode >= 1.17 passes `agent` to the chat.headers hook as the agent
 * NAME (a string); older versions passed the full `{ name, mode }` object.
 * The plugin must classify subagents correctly in both shapes — a string
 * agent silently mapped to "primary" sends subagent traffic out at the
 * primary 1M tier, burning rate-limit budget and (field-observed) tripping
 * Anthropic's extra-usage metering on fresh subagent sessions.
 *
 * `headersFor` seeds `output.headers` with the headers OPENCODE ITSELF puts
 * there before the hook runs. It used to seed `{}`, which modelled the
 * plugin's contribution in isolation and made an entire class of change look
 * verified when it was a no-op: a header the plugin stops setting is still on
 * the wire if OpenCode set it, and Meridian reads the wire.
 *
 * Extracted from the OpenCode 1.18.11 binary (bun-compiled; visible via
 * `strings`), for any provider whose id does not start with "opencode" — which
 * is every request that reaches Meridian:
 *
 *   headers: {
 *     ...(providerID.startsWith("opencode")
 *        ? { "x-opencode-session": sessionID, "x-opencode-request": user.id, ... }
 *        : { "x-session-affinity": sessionID, "X-Session-Id": sessionID,
 *            ...(parentSessionID ? {"x-parent-session-id": parentSessionID} : {}),
 *            "User-Agent": Ri }),
 *     ...model.headers,
 *     ...f            // f = this plugin's chat.headers output — spread LAST
 *   }
 *
 * Two facts follow, and both are load-bearing for anything that touches
 * session identity:
 *
 *   1. OpenCode ALWAYS contributes `x-session-affinity` (and `X-Session-Id`)
 *      on this path. A plugin cannot remove that key by declining to set one.
 *   2. Plugin headers are spread LAST, so a plugin CAN override it.
 */
import { describe, it, expect } from "bun:test"
import MeridianPlugin from "../../plugin/meridian"
import { openCodeAdapter } from "../proxy/adapters/opencode"

type Hooks = Awaited<ReturnType<typeof MeridianPlugin>>

async function instance(cfgAgents?: Record<string, { mode?: string }>): Promise<Hooks> {
  const hooks = await MeridianPlugin({})
  if (cfgAgents) await hooks.config?.({ agent: cfgAgents })
  return hooks
}

/** The headers OpenCode puts on `output.headers` before the hook runs. */
function openCodeBaseHeaders(sessionID: string): Record<string, string> {
  return {
    "x-session-affinity": sessionID,
    "X-Session-Id": sessionID,
    "User-Agent": "opencode/1.18.11 ai-sdk/provider-utils/4.0.27 runtime/bun/1.3.14",
  }
}

async function headersFor(
  hooks: Hooks,
  agent: unknown,
  providerID = "anthropic",
  sessionID = "ses_test",
): Promise<Record<string, string>> {
  // Seeded, not empty — see the note at the top of this file.
  const output = { headers: openCodeBaseHeaders(sessionID) }
  await hooks["chat.headers"]!(
    {
      sessionID,
      agent: agent as any,
      model: { providerID },
      message: { id: "msg_test" },
    },
    output,
  )
  return output.headers
}

/** Resolve a header bag the way the proxy does, so a test can assert on the
 *  session key Meridian actually derives rather than on one header. */
function sessionKeyFor(headers: Record<string, string>): string | undefined {
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return openCodeAdapter.getSessionId({ req: { header: (n: string) => lower[n.toLowerCase()] } } as any)
}

describe("plugin/meridian.ts agent-mode header", () => {
  it("legacy object agent: reads mode directly", async () => {
    const hooks = await instance()
    const h = await headersFor(hooks, { name: "explore", mode: "subagent" })
    expect(h["x-opencode-agent-mode"]).toBe("subagent")
    expect(h["x-opencode-agent-name"]).toBe("explore")
  })

  it("string agent: built-in subagents resolve to subagent", async () => {
    const hooks = await instance()
    expect((await headersFor(hooks, "explore"))["x-opencode-agent-mode"]).toBe("subagent")
    expect((await headersFor(hooks, "general"))["x-opencode-agent-mode"]).toBe("subagent")
  })

  it("string agent: built-in primaries resolve to primary", async () => {
    const hooks = await instance()
    expect((await headersFor(hooks, "build"))["x-opencode-agent-mode"]).toBe("primary")
    expect((await headersFor(hooks, "plan"))["x-opencode-agent-mode"]).toBe("primary")
  })

  it("string agent: user-defined subagent from config resolves to subagent", async () => {
    const hooks = await instance({ "code-reviewer": { mode: "subagent" } })
    expect((await headersFor(hooks, "code-reviewer"))["x-opencode-agent-mode"]).toBe("subagent")
  })

  it("string agent: config override of a built-in wins", async () => {
    const hooks = await instance({ general: { mode: "primary" } })
    expect((await headersFor(hooks, "general"))["x-opencode-agent-mode"]).toBe("primary")
  })

  it("string agent: unknown names fall back to primary", async () => {
    const hooks = await instance()
    expect((await headersFor(hooks, "mystery-agent"))["x-opencode-agent-mode"]).toBe("primary")
  })

  it('mode "all" is normalized to primary', async () => {
    const hooks = await instance({ flexible: { mode: "all" } })
    expect((await headersFor(hooks, "flexible"))["x-opencode-agent-mode"]).toBe("primary")
    const legacy = await headersFor(hooks, { name: "flexible", mode: "all" })
    expect(legacy["x-opencode-agent-mode"]).toBe("primary")
  })

  it("session and request headers are always set for anthropic requests", async () => {
    const hooks = await instance()
    const h = await headersFor(hooks, "explore")
    expect(h["x-opencode-session"]).toBe("ses_test")
    expect(h["x-opencode-request"]).toBe("msg_test")
  })

  it("non-anthropic providers get none of the plugin's headers", async () => {
    const hooks = await instance()
    const h = await headersFor(hooks, "title", "openrouter")
    // Asserted per-key, not as an empty bag. OpenCode's own base headers are
    // there regardless of provider, and "the bag is empty" would have quietly
    // stopped being the same claim as "the plugin added nothing".
    for (const k of [
      "x-opencode-session",
      "x-opencode-request",
      "x-opencode-agent-mode",
      "x-opencode-agent-name",
    ]) {
      expect(h[k]).toBeUndefined()
    }
  })

  it("agent names are sanitized to printable ASCII", async () => {
    const hooks = await instance()
    const h = await headersFor(hooks, "expl\u200bore\u2728")
    expect(h["x-opencode-agent-name"]).toBe("explore")
  })

  it("config hook state is per plugin instance", async () => {
    const a = await instance({ shared: { mode: "subagent" } })
    const b = await instance()
    expect((await headersFor(a, "shared"))["x-opencode-agent-mode"]).toBe("subagent")
    expect((await headersFor(b, "shared"))["x-opencode-agent-mode"]).toBe("primary")
  })

  it("config hook re-fire drops agents removed from config", async () => {
    const hooks = await instance({ temp: { mode: "subagent" } })
    expect((await headersFor(hooks, "temp"))["x-opencode-agent-mode"]).toBe("subagent")
    await hooks.config?.({ agent: {} })
    expect((await headersFor(hooks, "temp"))["x-opencode-agent-mode"]).toBe("primary")
  })

  it("config hook re-fire restores built-in mode when an override is removed", async () => {
    const hooks = await instance({ general: { mode: "primary" } })
    expect((await headersFor(hooks, "general"))["x-opencode-agent-mode"]).toBe("primary")
    await hooks.config?.({ agent: {} })
    expect((await headersFor(hooks, "general"))["x-opencode-agent-mode"]).toBe("subagent")
  })

  /**
   * The proposition PR #845 believed it had proved, stated as a test.
   *
   * It stopped the plugin setting `x-opencode-session` for title/summary,
   * expecting that to detach those one-shots from the user's conversation. It
   * does not: OpenCode's own `x-session-affinity` survives, and
   * `openCodeAdapter.getSessionId` reads `x-opencode-session ?? x-session-affinity`.
   * With `output.headers` seeded as `{}` the old harness could not see this, so
   * the change shipped a green CI on a no-op.
   *
   * These assert on the key Meridian DERIVES, not on any single header, so they
   * stay true through any future reshuffle of which header carries the id.
   */
  describe("session identity as the proxy resolves it", () => {
    it("a request keeps a session key even with no x-opencode-session at all", async () => {
      const hooks = await instance()
      const h = await headersFor(hooks, "build")
      delete h["x-opencode-session"]      // what #845 did
      expect(sessionKeyFor(h)).toBe("ses_test")   // still keyed, via x-session-affinity
    })

    it("dropping x-opencode-session does NOT separate a one-shot from the user's turn", async () => {
      const hooks = await instance()
      const title = await headersFor(hooks, "title")
      const build = await headersFor(hooks, "build")
      delete title["x-opencode-session"]
      delete build["x-opencode-session"]
      // Both fall back to the same x-session-affinity. Identical keys would be
      // the collision back; they differ only because the proxy scopes by agent.
      expect(title["x-session-affinity"]).toBe(build["x-session-affinity"])
      expect(sessionKeyFor(title)).not.toBe(sessionKeyFor(build))
    })

    it("the plugin can override OpenCode's base header, because it is spread last", async () => {
      const hooks = await instance()
      const h = await headersFor(hooks, "build")
      // Not a claim about today's plugin — a claim about the hook contract that
      // any header-based fix depends on. Verified against the 1.18.11 binary.
      h["x-session-affinity"] = "overridden"
      expect(sessionKeyFor({ ...h, "x-opencode-session": undefined as any })).toBe("overridden")
    })

    it("the user's turn and each internal one-shot resolve to distinct keys", async () => {
      const hooks = await instance()
      const keys = new Set<string | undefined>()
      for (const agent of ["build", "title", "summary", "compaction"]) {
        keys.add(sessionKeyFor(await headersFor(hooks, agent)))
      }
      expect(keys.size).toBe(4)
    })
  })
})
