import { describe, expect, test } from "bun:test"
import { serializeTransaction } from "viem"
import { EXECUTE_V2_SELECTOR } from "../src/abi"
import { ARKIV_ADDRESS, LEGACY_EXECUTE_SELECTOR } from "../src/decoder"
import { MAX_INPUT_BYTES, handleRequest } from "../src/server"
import { attr, createOpV2, deleteOpV2, encodeExecuteV2, extendOpV2 } from "./encodeV2"
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

describe("decoding generation-2 calldata over HTTP", () => {
  test("POST /api/decode decodes a create", async () => {
    const data = encodeExecuteV2([
      createOpV2({
        minLifetime: 30n,
        attributes: [attr.str("$contentType", "text/plain"), attr.bytes("$payload", new TextEncoder().encode("hi"))],
      }),
    ])
    const { status, body } = await call("/api/decode", post({ data }))
    expect(status).toBe(200)
    expect(body.abi).toBe("v2")
    expect(body.selector).toBe(EXECUTE_V2_SELECTOR)
    expect(body.operationCount).toBe(1)
    expect(body.operations[0].operation).toBe("create")
    expect(body.operations[0].payload.size).toBe(2)
    expect(body.operations[0].contentType).toBe("text/plain")
  })

  test("blockNumber resolves the expiry, and its absence leaves it null", async () => {
    const data = encodeExecuteV2([extendOpV2(ENTITY_KEY, 0n, 150n)])
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
    const data = encodeExecuteV2([
      createOpV2({ attributes: [attr.str("kind", "smoke"), attr.bytes("$payload", new Uint8Array(8))] }),
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
    expect(body.knownSelectors).toEqual([EXECUTE_V2_SELECTOR, LEGACY_EXECUTE_SELECTOR])
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
    const data = encodeExecuteV2([{ operation: 6, operationData: "0x" }])
    const { status, body } = await call("/api/decode", asIndexer(data))
    expect(status).toBe(200)
    expect(body.operations[0].undecodable.code).toBe("UNKNOWN_OPERATION_TAG")
    expect(body.operations[0].operation).toBe("unknown(6)")
    expect(body.operations[0].operationType).toBe(6)
  })

  test("operationData that does not match the struct is a 200 row", async () => {
    const data = encodeExecuteV2([{ operation: 5, operationData: "0x1234" }])
    const { status, body } = await call("/api/decode", asIndexer(data))
    expect(status).toBe(200)
    expect(body.operations[0].undecodable.code).toBe("MALFORMED_OPERATION_DATA")
  })

  test("a known selector with a broken argument block is a 200 empty batch", async () => {
    const { status, body } = await call("/api/decode", asIndexer(`${EXECUTE_V2_SELECTOR}deadbeef`))
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

  test("the shape arkiv-chain-indexer parses survives an undecodable operation", async () => {
    const data = encodeExecuteV2([{ operation: 6, operationData: "0xdeadbeef" }])
    const { body } = await call("/api/decode", asIndexer(data))
    // parseDecoderOperation throws unless all four of these are present and typed.
    const op = body.operations[0]
    expect(typeof op.operationType).toBe("number")
    expect(typeof op.operation).toBe("string")
    expect(typeof op.payload.size).toBe("number")
    expect(Array.isArray(op.attributes)).toBe(true)
  })

  test("a registry read-only call decodes to zero operations, not an error", async () => {
    const { status, body } = await call("/api/decode", post({ data: `0x36917bfd${"00".repeat(32)}` }))
    expect(status).toBe(200)
    expect(body.functionName).toBe("entityNonce")
    expect(body.operations).toEqual([])
  })
})

describe("request handling", () => {
  test("input above the cap is 413", async () => {
    const oversize = `0x${"00".repeat(MAX_INPUT_BYTES / 2)}`
    const { status, body } = await call("/api/decode", post({ data: oversize }))
    expect(status).toBe(413)
    expect(body.code).toBe("INPUT_TOO_LARGE")
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
    expect(decodable.map((s: { selector: string }) => s.selector)).toEqual([
      EXECUTE_V2_SELECTOR,
      LEGACY_EXECUTE_SELECTOR,
    ])
    expect(body.maxInputBytes).toBe(MAX_INPUT_BYTES)
  })

  test("the Rust service paths are served too, so swapping needs no config change", async () => {
    expect((await call("/healthz")).body.status).toBe("ok")
    const data = encodeExecuteV2([deleteOpV2(ENTITY_KEY)])
    const { status, body } = await call("/decode", post({ data }))
    expect(status).toBe(200)
    expect(body.operations[0].operation).toBe("delete")
  })

  test("GET /decode?data=... works", async () => {
    const data = encodeExecuteV2([deleteOpV2(ENTITY_KEY)])
    const { status, body } = await call(`/decode?data=${data}&blockNumber=100`)
    expect(status).toBe(200)
    expect(body.operations[0].entityKey).toBe(ENTITY_KEY)
  })
})
