/**
 * THE RULE, ENFORCED. This suite exists so a bug class stops recurring.
 *
 * FOR ANY CALLDATA INPUT, THIS SERVICE RETURNS EXACTLY TWO STATUSES: 400 for "not Arkiv
 * calldata", which the caller skips, and 200 for everything else, including calldata this
 * decoder cannot read, marked undecodable. Loudness for the operator lives in the log line
 * and the gap counter, never in the status code.
 *
 * It has been broken three times, each time by expressing "be loud" as a status: 422 and
 * 501 for an operation we could not read, then 413 for an oversized body. Each one handed
 * a stranger a permanent halt of arkiv-chain-indexer, because it throws on any status but
 * 200 and 400 (arkivOperations.ts:137-140) and scanBlockWithRetry then retries that same
 * block forever with no cap (scanner.ts:279). The transaction that does it need not even
 * succeed on chain: a reverted transaction is still in the block.
 *
 * So the corpus below is replayed in the exact body shape the indexer sends, and any third
 * status fails the build. If you are here because this suite went red, the signal you were
 * adding belongs in recordGap, not in the status. See CALLDATA_STATUS in src/server.ts.
 */
import { describe, expect, test } from "bun:test"
import { MAX_INPUT_BYTES, MIN_INPUT_BYTES, handleRequest } from "../src/server"
import {
  HOSTILE_CALLDATA,
  capRelativeOversize,
  chainSizedCalldata,
  largestChainSizedCalldata,
  oversizeAboveTheFloor,
  oversizeCalldata,
} from "./hostileCalldata"

const BASE = "http://localhost"
const ALLOWED = "200 or 400"
const RULE =
  "THE RULE: for any calldata input this service returns exactly two statuses. 400 means " +
  '"this is not Arkiv calldata", which arkiv-chain-indexer skips. 200 means everything ' +
  "else, including calldata this decoder cannot read, marked undecodable. The indexer " +
  "throws on any other status (arkivOperations.ts:137-140) and then retries that block " +
  "forever (scanner.ts:279), so a third status is a permanent halt bought with one " +
  "transaction. Put the signal in recordGap instead. See CALLDATA_STATUS in src/server.ts."

/** Names the offending case and states the rule, so a red build explains itself. */
function verdict(name: string, status: number): string {
  return status === 200 || status === 400 ? ALLOWED : `HTTP ${status} for "${name}". ${RULE}`
}

async function decode(init: RequestInit, path = "/api/decode") {
  const res = await handleRequest(new Request(`${BASE}${path}`, init))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

/** The exact body arkiv-chain-indexer sends: data plus chainId, and never a `to`. */
function asIndexer(data: string): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data, chainId: 7733102 }),
  }
}

describe("every calldata input answers 200 or 400", () => {
  for (const { name, data } of HOSTILE_CALLDATA) {
    test(name, async () => {
      const { status } = await decode(asIndexer(data))
      expect(verdict(name, status)).toBe(ALLOWED)
    })
  }
})

describe("the rule holds on every other way in", () => {
  test("raw hex posted as text/plain", async () => {
    for (const { name, data } of HOSTILE_CALLDATA) {
      const { status } = await decode({ method: "POST", headers: { "content-type": "text/plain" }, body: data })
      expect(verdict(`${name} (text/plain)`, status)).toBe(ALLOWED)
    }
  })

  test("GET with a data query parameter", async () => {
    for (const { name, data } of HOSTILE_CALLDATA) {
      const { status } = await decode({ method: "GET" }, `/api/decode?data=${encodeURIComponent(data)}`)
      expect(verdict(`${name} (GET)`, status)).toBe(ALLOWED)
    }
  })

  test("the Rust service path, which callers may still be pointed at", async () => {
    for (const { name, data } of HOSTILE_CALLDATA) {
      const { status } = await decode(asIndexer(data), "/decode")
      expect(verdict(`${name} (/decode)`, status)).toBe(ALLOWED)
    }
  })

  test("a `to` the caller supplied never changes the status either", async () => {
    // The one production caller never sends `to`, but a call that does must not be able to
    // pick a different status for the same bytes.
    for (const { name, data } of HOSTILE_CALLDATA) {
      const { status } = await decode({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data, chainId: 7733102, to: "0x0000000000000000000000000000000000000000" }),
      })
      expect(verdict(`${name} (with to)`, status)).toBe(ALLOWED)
    }
  })
})

describe("a body the size of real traffic answers 200 or 400", () => {
  // Built here rather than at module scope: each of these costs megabytes.
  for (const { name, data } of [...chainSizedCalldata(), ...oversizeCalldata()]) {
    test(name, async () => {
      const { status } = await decode(asIndexer(data))
      expect(verdict(name, status)).toBe(ALLOWED)
    })
  }
})

/**
 * The other half of the size question, and the half the old fraction-sized corpus could not
 * ask. The status rule alone is satisfied by refusing everything, so these assert WHICH
 * answer each size gets: a body the chain can produce must decode, and only a body above the
 * cap may come back INPUT_TOO_LARGE.
 */
describe("the cap falls on the right side of real traffic", () => {
  function gapCode(body: Record<string, unknown>): string | undefined {
    return (body.undecodable as { code?: string } | undefined)?.code
  }

  for (const { name, data } of chainSizedCalldata()) {
    test(`${name} decodes`, async () => {
      const { status, body } = await decode(asIndexer(data))
      expect(`${name}: HTTP ${status}, gap ${gapCode(body) ?? "none"}`).toBe(`${name}: HTTP 200, gap none`)
      expect(body.operationCount).toBe(1)
    })
  }

  test("a body above the cap is refused, so the oversize path is really exercised", async () => {
    const { status, body } = await decode(asIndexer(capRelativeOversize().data))
    expect(status).toBe(200)
    expect(gapCode(body)).toBe("INPUT_TOO_LARGE")
  })

  test("the corpus holds a body larger than the smallest legal cap", () => {
    // The anti-blindness invariant, stated. The oversize cases used to be fractions of
    // MAX_INPUT_BYTES, so the suite could not build a body larger than the cap at any cap
    // value and passed at settings where a real transaction never reaches the handler. This
    // one is an absolute size and MIN_INPUT_BYTES is a fixed floor, so the comparison is
    // between two constants and cannot be configured away.
    expect(oversizeAboveTheFloor().data.length).toBeGreaterThan(MIN_INPUT_BYTES)
  })
})

/**
 * arkiv-chain-indexer's own branching, copied from src/arkivOperations.ts:137-146 and
 * :173-190, so this suite goes red instead of the scanner wedging.
 *
 * The status is only half of it. parseDecoderResponse throws when `operations` is missing,
 * and parseDecoderOperation throws when any row lacks the four fields it reads, and neither
 * throw is caught anywhere above: they reach scanBlockWithRetry and halt the same block
 * forever, exactly as a 413 did.
 */
function asTheIndexerWouldSee(status: number, body: Record<string, unknown>): "skipped" | number {
  if (status === 400) return "skipped"
  if (status < 200 || status >= 300) throw new Error(`Arkiv decoder returned HTTP ${status}`)
  if (!Array.isArray(body.operations)) throw new Error("Arkiv decoder returned an unexpected response shape")
  body.operations.forEach((op: unknown, index: number) => {
    const row = op as Record<string, unknown>
    const payload = row?.payload as Record<string, unknown> | undefined
    if (
      typeof row !== "object" ||
      row === null ||
      typeof row.operationType !== "number" ||
      typeof row.operation !== "string" ||
      typeof payload !== "object" ||
      payload === null ||
      typeof payload.size !== "number" ||
      !Array.isArray(row.attributes)
    ) {
      throw new Error(`Arkiv decoder returned an unexpected operation shape at index ${index}`)
    }
  })
  return body.operations.length
}

describe("the caller survives the whole corpus", () => {
  test("nothing in it makes arkiv-chain-indexer throw", async () => {
    const halts: string[] = []
    for (const { name, data } of [...HOSTILE_CALLDATA, ...chainSizedCalldata(), ...oversizeCalldata()]) {
      const { status, body } = await decode(asIndexer(data))
      try {
        asTheIndexerWouldSee(status, body)
      } catch (e) {
        halts.push(`"${name}" -> ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    // Each entry here is a block the scanner would retry forever.
    expect(halts).toEqual([])
  })
})

describe("a flooded gap tally does not change any answer", () => {
  test("the rule still holds after the tally is full of attacker-chosen subjects", async () => {
    for (let i = 0; i < 300; i++) {
      await decode(asIndexer(`0x${(0x30000000 + i).toString(16)}${"00".repeat(32)}`))
    }
    for (const { name, data } of HOSTILE_CALLDATA) {
      const { status } = await decode(asIndexer(data))
      expect(verdict(`${name} (tally full)`, status)).toBe(ALLOWED)
    }
  })
})

describe("an unexpected throw inside the decoder is a gap, not a 500", () => {
  test("a body that fails mid-read comes back 200 with DECODER_FAULT", async () => {
    // The last-resort branch. It used to be a 500, which halts the indexer exactly like
    // the 413 did, and the bytes that reach it are attacker-chosen. A failing body stream
    // is the one way to trigger it from outside, since every decode path returns instead
    // of throwing. console.error plus the named counter carry the alarm.
    const res = await handleRequest(
      new Request(`${BASE}/api/decode`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new ReadableStream({
          start(controller) {
            controller.error(new Error("socket died mid-body"))
          },
        }),
        duplex: "half",
      }),
    )
    const body = (await res.json()) as Record<string, unknown>
    expect(verdict("a body that fails mid-read", res.status)).toBe(ALLOWED)
    expect((body.undecodable as { code: string }).code).toBe("DECODER_FAULT")
    expect(asTheIndexerWouldSee(res.status, body)).toBe(0)
  })
})

describe("the framework cannot answer before the handler", () => {
  /**
   * Bun.serve answers an oversized body itself, with a 413, and never runs fetch. That is
   * the one way the rule can be broken from outside src/server.ts, so its ceiling is set
   * above MAX_INPUT_BYTES rather than at it. These two tests are that decision, executable.
   */
  async function statusOverASocket(maxRequestBodySize: number, body: string): Promise<number> {
    const server = Bun.serve({ port: 0, maxRequestBodySize, fetch: handleRequest })
    try {
      const res = await fetch(`http://localhost:${server.port}/api/decode`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
      await res.text()
      return res.status
    } finally {
      server.stop(true)
    }
  }

  const oversize = JSON.stringify({ data: capRelativeOversize().data, chainId: 7733102 })
  /** The largest body a transaction can turn into, once the contemplated 512 KB lands. */
  const chainSized = JSON.stringify({ data: largestChainSizedCalldata().data, chainId: 7733102 })

  test("a body above the cap still reaches handleRequest and comes back 200", async () => {
    expect(verdict("oversize body over a real socket", await statusOverASocket(MAX_INPUT_BYTES * 2, oversize))).toBe(
      ALLOWED,
    )
  })

  test("an oversized body does not poison the next request on the same connection", async () => {
    // fetch pools connections. Answering before the body has been read leaves the
    // remainder on the socket, and Bun parses those bytes as the next request's headers.
    // Without discardBody in src/server.ts every second request on that connection is
    // answered from garbage: 431 when the leftover bytes are "abab...", and 400 when they
    // are "0000...". The status alone does not catch it, because a spurious 400 is inside
    // the rule and the caller reads it as "not Arkiv calldata, skip" -- a transaction
    // dropped silently, which is worse than the halt. So assert the answer, not the code.
    const server = Bun.serve({ port: 0, maxRequestBodySize: MAX_INPUT_BYTES * 2, fetch: handleRequest })
    try {
      const answers: string[] = []
      for (let i = 0; i < 4; i++) {
        const res = await fetch(`http://localhost:${server.port}/api/decode`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: oversize,
        })
        const text = await res.text()
        expect(verdict(`oversize body, request ${i + 1} on a reused connection`, res.status)).toBe(ALLOWED)
        let code: string
        try {
          code = ((JSON.parse(text) as Record<string, unknown>).undecodable as { code: string })?.code
        } catch {
          code = `unparseable response: ${JSON.stringify(text.slice(0, 40))}`
        }
        answers.push(code)
      }
      expect(answers).toEqual(["INPUT_TOO_LARGE", "INPUT_TOO_LARGE", "INPUT_TOO_LARGE", "INPUT_TOO_LARGE"])
    } finally {
      server.stop(true)
    }
  })

  test("setting the ceiling at the cap is the trap the *2 avoids", async () => {
    // Documents why src/server.ts must not pass MAX_INPUT_BYTES here. If this ever stops
    // being 413, Bun changed and the comment there needs revisiting.
    expect(await statusOverASocket(MAX_INPUT_BYTES, oversize)).toBe(413)
  })

  test("real traffic reaches the handler at the production ceiling", async () => {
    // The ceiling src/server.ts actually runs with, carrying the biggest body the chain can
    // produce. This is what the fraction-sized corpus never checked.
    const status = await statusOverASocket(MAX_INPUT_BYTES * 2, chainSized)
    expect(verdict("a 512 KB transaction over a real socket", status)).toBe(ALLOWED)
  })

  test("a ceiling below real traffic is a 413, which is what the floor exists to prevent", async () => {
    // 200 KB was a legal MAX_INPUT_BYTES before the floor, and this is what it bought: Bun
    // answers a real transaction itself, the handler never runs, and the two-status rule is
    // broken from outside src/server.ts. MIN_INPUT_BYTES now refuses that configuration at
    // startup, so this ceiling is unreachable in production. Kept executable because it is
    // the reason the floor is there.
    expect(await statusOverASocket(200_000, chainSized)).toBe(413)
  })
})

/**
 * The floor, executable. A cap under it is not a smaller memory budget, it is the 413 above
 * bought with an environment variable, so the service refuses to start instead of running
 * wrong. Checked in a subprocess because the refusal is process.exit at import time.
 */
describe("a cap below what the chain can produce refuses to start", () => {
  function startWith(maxInputBytes: string): { exitCode: number | null; stderr: string } {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `await import(${JSON.stringify(`${import.meta.dir}/../src/server.ts`)})`],
      env: { ...process.env, MAX_INPUT_BYTES: maxInputBytes },
      stderr: "pipe",
      stdout: "pipe",
    })
    return { exitCode: result.exitCode, stderr: result.stderr.toString() }
  }

  test("100 KB, which is under a single 128 KB transaction, is refused", () => {
    const { exitCode, stderr } = startWith("100000")
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain(`below the ${MIN_INPUT_BYTES} byte minimum`)
    expect(stderr).toContain("Refusing to start")
  })

  test("one byte under the floor is refused too", () => {
    expect(startWith(String(MIN_INPUT_BYTES - 1)).exitCode).not.toBe(0)
  })

  test("the floor itself starts", () => {
    expect(startWith(String(MIN_INPUT_BYTES)).exitCode).toBe(0)
  })
})
