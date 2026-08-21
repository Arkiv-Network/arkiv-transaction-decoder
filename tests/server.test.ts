import { describe, expect, test } from "bun:test"
import { serializeTransaction } from "viem"
import { ARKIV_ADDRESS, EXECUTE_SELECTOR, RETIRED_EXECUTE_SELECTOR } from "../src/abi"
import { MAX_INPUT_BYTES, handleRequest } from "../src/server"
import { attr, createOp, deleteOp, encodeExecute, extendOp } from "./encode"
import fixtures from "./fixtures/cheesecake.json"

const BASE = "http://localhost"
const ENTITY_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111" as const
const UNKNOWN_CALLDATA = `0xdeadbeef${"00".repeat(32)}`

async function call(path: string, init?: RequestInit) {
  const res = await handleRequest(new Request(`${BASE}${path}`, init))
  // biome-ignore lint: test helper, shape is asserted per test
  return { status: res.status, body: (await res.json()) as any }
}

function post(body: unknown) {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
}

describe("decoding registry calldata over HTTP", () => {
  test("POST /api/decode decodes a create", async () => {
    const data = encodeExecute([
      createOp({
        minLifetime: 30n,
        attributes: [attr.str("$contentType", "text/plain"), attr.bytes("$payload", new TextEncoder().encode("hi"))],
      }),
    ])
    const { status, body } = await call("/api/decode", post({ data }))
    expect(status).toBe(200)
    expect(body.selector).toBe(EXECUTE_SELECTOR)
    expect(body.operationCount).toBe(1)
    expect(body.operations[0].operation).toBe("create")
    expect(body.operations[0].payload.size).toBe(2)
    expect(body.operations[0].contentType).toBe("text/plain")
  })

  test("blockNumber resolves the expiry, and its absence leaves it null", async () => {
    const data = encodeExecute([extendOp(ENTITY_KEY, 0n, 150n)])
    const withBlock = await call("/api/decode", post({ data, blockNumber: 222495 }))
    expect(withBlock.body.operations[0].resolvedExpiresAt).toBe("222645")

    const without = await call("/api/decode", post({ data }))
    expect(without.body.operations[0].resolvedExpiresAt).toBeNull()
  })

  test("decodes real cheesecake calldata end to end", async () => {
    const fixture = fixtures.transactions.find((f) => f.label === "batch")!
    const { status, body } = await call(
      "/api/decode",
      post({ data: fixture.input, to: fixture.to, blockNumber: fixture.blockNumber, chainId: fixture.chainId }),
    )
    expect(status).toBe(200)
    expect(body.operationCount).toBe(3)
    expect(body.chainId).toBe(7733102)
  })

  test("the operation shape arkiv-chain-indexer requires is present", async () => {
    const data = encodeExecute([
      createOp({ attributes: [attr.str("kind", "smoke"), attr.bytes("$payload", new Uint8Array(8))] }),
    ])
    const { body } = await call("/api/decode", post({ data }))
    const op = body.operations[0]
    expect(typeof op.operationType).toBe("number")
    expect(typeof op.operation).toBe("string")
    expect(typeof op.payload.size).toBe("number")
    expect(Array.isArray(op.attributes)).toBe(true)
    for (const attribute of op.attributes) {
      expect(typeof attribute.key).toBe("string")
      expect(typeof attribute.valueType).toBe("number")
      expect(typeof attribute.valueTypeName).toBe("string")
      expect(typeof attribute.value).toBe("string")
    }
  })
})

describe("an unrecognised call is never silently skippable", () => {
  test("genuinely foreign data stays 400, the status callers treat as skip", async () => {
    const { status, body } = await call("/api/decode", post({ data: "0x1234" }))
    expect(status).toBe(400)
    expect(body.code).toBe("NOT_ARKIV_CALLDATA")
  })

  test("an unknown selector with no known target is 400 but names itself", async () => {
    const { status, body } = await call("/api/decode", post({ data: UNKNOWN_CALLDATA }))
    expect(status).toBe(400)
    // Foreign traffic until the target says otherwise, but still named so the caller
    // can see which selector was declined.
    expect(body.code).toBe("NOT_ARKIV_CALLDATA")
    expect(body.selector).toBe("0xdeadbeef")
    expect(body.targetIsRegistry).toBe(false)
    expect(body.knownSelectors).toEqual([EXECUTE_SELECTOR])
  })

  test("an unknown selector aimed at the registry names the target and still skips", async () => {
    const { status, body } = await call("/api/decode", post({ data: UNKNOWN_CALLDATA, to: ARKIV_ADDRESS }))
    expect(status).toBe(400)
    expect(body.code).toBe("UNKNOWN_SELECTOR")
    expect(body.selector).toBe("0xdeadbeef")
    expect(body.targetIsRegistry).toBe(true)
  })

  test("a serialized transaction to the registry carries its own target", async () => {
    const data = serializeTransaction({
      type: "eip1559",
      chainId: 7733102,
      to: ARKIV_ADDRESS,
      nonce: 0,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      gas: 21_000n,
      data: UNKNOWN_CALLDATA as `0x${string}`,
    })
    const { status, body } = await call("/api/decode", post({ data }))
    // A serialized transaction carries its own `to`, so its bytes used to pick the status.
    expect(status).toBe(400)
    expect(body.targetIsRegistry).toBe(true)
  })
})

/**
 * The blocker this suite exists for. arkiv-chain-indexer sends {data} or {data, chainId},
 * never `to`; it maps 400 to skip and throws on everything else; and scanBlockWithRetry
 * then retries the same block forever with no cap. So any status but 200 or 400 on
 * attacker-controlled calldata stops the indexer permanently.
 */
describe("calldata anyone can send never picks the status code", () => {
  /** The exact body arkiv-chain-indexer sends: data plus chainId, and no `to`. */
  function asIndexer(data: string) {
    return post({ data, chainId: 7733102 })
  }

  test("an unknown operation tag is a 200 row, not a 422", async () => {
    const data = encodeExecute([{ operation: 6, operationData: "0x" }])
    const { status, body } = await call("/api/decode", asIndexer(data))
    expect(status).toBe(200)
    expect(body.operations[0].undecodable.code).toBe("UNKNOWN_OPERATION_TAG")
    expect(body.operations[0].operation).toBe("unknown(6)")
    expect(body.operations[0].operationType).toBe(6)
  })

  test("operationData that does not match the struct is a 200 row", async () => {
    const data = encodeExecute([{ operation: 5, operationData: "0x1234" }])
    const { status, body } = await call("/api/decode", asIndexer(data))
    expect(status).toBe(200)
    expect(body.operations[0].undecodable.code).toBe("MALFORMED_OPERATION_DATA")
  })

  test("a known selector with a broken argument block is a 200 empty batch", async () => {
    const { status, body } = await call("/api/decode", asIndexer(`${EXECUTE_SELECTOR}deadbeef`))
    expect(status).toBe(200)
    expect(body.undecodable.code).toBe("MALFORMED_CALLDATA")
    expect(body.operations).toEqual([])
    expect(body.chainId).toBe(7733102)
  })

  test("an unknown selector with no `to` still reaches the operator", async () => {
    // The one production caller sends {data, chainId} and nothing else, so a loud path
    // gated on `to` never fires for it. The counter has to work without that field.
    const before = await call("/api/selectors")
    const seen = (s: { subject: string }) => s.subject === "0xc0ffee01"
    expect(before.body.gaps.filter(seen)).toEqual([])

    const { status, body } = await call("/api/decode", asIndexer(`0xc0ffee01${"00".repeat(32)}`))
    expect(status).toBe(400)

    const after = await call("/api/selectors")
    expect(after.body.gaps.find(seen)).toEqual({ code: "UNKNOWN_SELECTOR", subject: "0xc0ffee01", count: 1 })

    await call("/api/decode", asIndexer(`0xc0ffee01${"11".repeat(32)}`))
    const twice = await call("/api/selectors")
    expect(twice.body.gaps.find(seen).count).toBe(2)
    expect(body.code).toBeString()
  })

  test("the gap tally is capped, since the subject is attacker-chosen", async () => {
    // Anyone can send a transaction with a selector nobody has used before.
    for (let i = 0; i < 400; i++) {
      await call("/api/decode", asIndexer(`0x${(0x10000000 + i).toString(16)}${"00".repeat(32)}`))
    }
    const { body } = await call("/api/selectors")
    expect(body.gaps.length).toBeLessThanOrEqual(260)
    // Nothing is lost: the overflow lands in the code's own bucket.
    const total = body.gaps
      .filter((g: { code: string }) => g.code === "UNKNOWN_SELECTOR")
      .reduce((sum: number, g: { count: number }) => sum + g.count, 0)
    expect(total).toBeGreaterThanOrEqual(400)
  })

  test("a genuinely new registry selector stays loud after the tally is flooded", async () => {
    // The bug this replaces: once full, the tally refused new keys, so 256 reverted
    // transactions bought silence for the next real selector. It produced no log line and
    // no named entry, which is both halves of the operator's only channel.
    const fresh = "0xabcd1234"
    const recurring = "0xfeedface"
    for (let i = 0; i < 6; i++) await call("/api/decode", asIndexer(`${recurring}${"00".repeat(32)}`))
    for (let i = 0; i < 300; i++) {
      await call("/api/decode", asIndexer(`0x${(0x20000000 + i).toString(16)}${"00".repeat(32)}`))
    }

    const lines: string[] = []
    const warn = console.warn
    console.warn = (line: string) => {
      lines.push(line)
    }
    await call("/api/decode", asIndexer(`${fresh}${"00".repeat(32)}`))
    console.warn = warn

    const { body } = await call("/api/selectors")
    expect(lines.filter((line) => line.includes(fresh))).toHaveLength(1)
    expect(body.gaps.find((g: { subject: string }) => g.subject === fresh)).toEqual({
      code: "UNKNOWN_SELECTOR",
      subject: fresh,
      count: 1,
    })
    // A selector that recurs outranks single-shot noise, so the churn never reaches it.
    expect(body.gaps.find((g: { subject: string }) => g.subject === recurring).count).toBe(6)
    // Still bounded: 256 named subjects plus one anonymous bucket per code.
    expect(body.gaps.length).toBeLessThanOrEqual(264)
  })

  test("the shape arkiv-chain-indexer parses survives an undecodable operation", async () => {
    const data = encodeExecute([{ operation: 6, operationData: "0xdeadbeef" }])
    const { body } = await call("/api/decode", asIndexer(data))
    // parseDecoderOperation throws unless all four of these are present and typed.
    const op = body.operations[0]
    expect(typeof op.operationType).toBe("number")
    expect(typeof op.operation).toBe("string")
    expect(typeof op.payload.size).toBe("number")
    expect(Array.isArray(op.attributes)).toBe(true)
  })

  test("generation-1 calldata is a 200 gap, not a 400 skip", async () => {
    // The judgement call at the HTTP edge. 400 would tell the caller "not Arkiv calldata",
    // and with no `to` the code would read NOT_ARKIV_CALLDATA, which is what anyone sizing
    // foreign traffic counts. It is registry traffic we cannot read, so it is a gap.
    const { status, body } = await call("/api/decode", asIndexer(`${RETIRED_EXECUTE_SELECTOR}${"00".repeat(64)}`))
    expect(status).toBe(200)
    expect(body.undecodable.code).toBe("RETIRED_GENERATION")
    expect(body.selector).toBe(RETIRED_EXECUTE_SELECTOR)
    expect(body.operations).toEqual([])
    expect(body.chainId).toBe(7733102)

    // The operator half: counted under the retired selector, so a legacy chain coming back
    // is a rising number next to 0xba8ccf92 and not one folded in with unknown selectors.
    const { body: selectors } = await call("/api/selectors")
    const tally = selectors.gaps.find(
      (g: { code: string; subject: string }) =>
        g.code === "RETIRED_GENERATION" && g.subject === RETIRED_EXECUTE_SELECTOR,
    )
    expect(tally.count).toBeGreaterThanOrEqual(1)
  })

  test("a registry read-only call decodes to zero operations, not an error", async () => {
    const { status, body } = await call("/api/decode", post({ data: `0x36917bfd${"00".repeat(32)}` }))
    expect(status).toBe(200)
    expect(body.functionName).toBe("entityNonce")
    expect(body.operations).toEqual([])
  })
})

/** Routes with nothing to do with any ABI. They were covered by the suite generation 1
 *  took with it, so they live here now. */
describe("the routes around the decoder", () => {
  test("GET / returns usage info", async () => {
    const { status, body } = await call("/")
    expect(status).toBe(200)
    expect(body.service).toBe("arkiv-transaction-decoder")
    expect(body.version).toBe("v0.1.0")
    expect(body.endpoints["GET /api/version"]).toBe("service version")
  })

  test("GET /api/health returns ok", async () => {
    const { status, body } = await call("/api/health")
    expect(status).toBe(200)
    expect(body.status).toBe("ok")
  })

  test("GET /api/version returns the service version", async () => {
    const { status, body } = await call("/api/version")
    expect(status).toBe(200)
    expect(body).toEqual({ service: "arkiv-transaction-decoder", version: "v0.1.0" })
  })

  test("POST /api/decode accepts raw hex as a text body", async () => {
    const data = encodeExecute([deleteOp(ENTITY_KEY)])
    const { status, body } = await call("/api/decode", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: data,
    })
    expect(status).toBe(200)
    expect(body.operations[0].operation).toBe("delete")
  })

  test("POST /api/decode with no body at all is 400", async () => {
    const { status, body } = await call("/api/decode", { method: "POST" })
    expect(status).toBe(400)
    expect(body.error).toContain("Missing transaction data")
  })

  test("an unsupported method on /api/decode is 405", async () => {
    expect((await call("/api/decode", { method: "DELETE" })).status).toBe(405)
  })

  test("an unknown route is 404", async () => {
    expect((await call("/nope")).status).toBe(404)
  })
})

describe("request handling", () => {
  test("a body above the cap is a recorded gap at 200, never a 413", async () => {
    // The body size is chosen by whoever sent the transaction, not by the caller, so it
    // does not get to pick the status. 413 here was the same halt as the old 422: the
    // indexer throws on it and scanBlockWithRetry retries that block forever. Ordinary
    // valid usage reaches this cap too, at eight creates of MAX_PAYLOAD_BYTES each.
    const oversize = `0x${"00".repeat(MAX_INPUT_BYTES / 2)}`
    const { status, body } = await call("/api/decode", post({ data: oversize }))
    expect(status).toBe(200)
    expect(body.undecodable.code).toBe("INPUT_TOO_LARGE")
    expect(body.operationCount).toBe(0)
    expect(body.operations).toEqual([])

    // The loud half, in the channel that cannot stop the caller.
    const { body: selectors } = await call("/api/selectors")
    const tally = selectors.gaps.find((g: { code: string }) => g.code === "INPUT_TOO_LARGE")
    expect(tally.count).toBeGreaterThanOrEqual(1)
  })

  test("a malformed to or blockNumber is a request error, not a decode error", async () => {
    expect((await call("/api/decode", post({ data: "0x", to: "nope" }))).status).toBe(400)
    expect((await call("/api/decode", post({ data: "0x", blockNumber: "abc" }))).body.code).toBe("BAD_REQUEST")
  })

  test("a broken body is the caller's bug, not a traffic classification", async () => {
    // Counting NOT_ARKIV_CALLDATA to size non-Arkiv traffic must not also count clients
    // that send bad JSON.
    const badJson = await call("/api/decode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    })
    expect(badJson.status).toBe(400)
    expect(badJson.body.code).toBe("BAD_REQUEST")

    const badShape = await call("/api/decode", post({ payload: "0x00" }))
    expect(badShape.status).toBe(400)
    expect(badShape.body.code).toBe("BAD_REQUEST")
  })

  test("GET /api/selectors lists what this service decodes", async () => {
    const { status, body } = await call("/api/selectors")
    expect(status).toBe(200)
    const decodable = body.selectors.filter((s: { decodes: boolean }) => s.decodes)
    expect(decodable.map((s: { selector: string }) => s.selector)).toEqual([EXECUTE_SELECTOR])
    // Recognised and refused, listed so the retirement is visible from outside the logs.
    expect(body.selectors.find((s: { retired?: boolean }) => s.retired)).toMatchObject({
      selector: RETIRED_EXECUTE_SELECTOR,
      decodes: false,
    })
    expect(body.maxInputBytes).toBe(MAX_INPUT_BYTES)
  })

  test("the Rust service paths are served too, so swapping needs no config change", async () => {
    expect((await call("/healthz")).body.status).toBe("ok")
    const data = encodeExecute([deleteOp(ENTITY_KEY)])
    const { status, body } = await call("/decode", post({ data }))
    expect(status).toBe(200)
    expect(body.operations[0].operation).toBe("delete")
  })

  test("GET /decode?data=... works", async () => {
    const data = encodeExecute([deleteOp(ENTITY_KEY)])
    const { status, body } = await call(`/decode?data=${data}&blockNumber=100`)
    expect(status).toBe(200)
    expect(body.operations[0].entityKey).toBe(ENTITY_KEY)
  })
})
