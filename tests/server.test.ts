import { describe, expect, spyOn, test } from "bun:test"
import * as decoder from "../src/decoder"
import { MAX_BODY_BYTES, handleRequest } from "../src/server"
import { SERVICE_NAME, SERVICE_VERSION } from "../src/version"
import { bytesCell, createOp, deleteOp, encodeExecute, strCell } from "./encode"

const BASE = "http://localhost"
const ENTITY_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111" as const

async function call(path: string, init?: RequestInit) {
  const res = await handleRequest(new Request(`${BASE}${path}`, init))
  // biome-ignore lint: test helper, shape is asserted per test
  return { status: res.status, body: (await res.json()) as any }
}

const createCalldata = encodeExecute([
  createOp({
    minLifetime: 100n,
    attributes: [bytesCell("body", "Hello Arkiv"), strCell("k", "v")],
  }),
])

describe("server", () => {
  test("GET / returns usage info", async () => {
    const { status, body } = await call("/")
    expect(status).toBe(200)
    expect(body.service).toBe(SERVICE_NAME)
    expect(body.version).toBe(SERVICE_VERSION)
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
    expect(body).toEqual({
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
    })
  })

  test("the reported version is the one package.json declares", async () => {
    // Read the file afresh rather than through the module, so a version.ts that stopped deriving
    // from package.json would be caught.
    const pkg = JSON.parse(await Bun.file(`${import.meta.dir}/../package.json`).text())
    expect(SERVICE_NAME).toBe(pkg.name)
    expect(SERVICE_VERSION).toBe(`v${pkg.version}`)
  })

  test("POST /api/decode decodes execute calldata from a JSON body", async () => {
    const { status, body } = await call("/api/decode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: createCalldata }),
    })

    expect(status).toBe(200)
    expect(body.functionName).toBe("execute")
    expect(body.format).toBe("udc")
    expect(body.operations).toHaveLength(1)
    expect(body.operations[0].operation).toBe("create")
    expect(body.operations[0].minLifetime).toBe("100")
    expect(body.operations[0].bytesSize).toBe(11)
    expect(body.operations[0].attributes[0].value).toBeNull()
    expect(body.operations[0].attributes[1]).toEqual({
      name: "k",
      typeId: 0x88,
      type: "str",
      indexed: true,
      value: "v",
      size: 1,
    })
  })

  test("POST /decode serves the same route without the /api prefix", async () => {
    // What the chain indexer calls: <base>/decode, with the chain id alongside the calldata.
    const { status, body } = await call("/decode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: createCalldata, chainId: 60138453025 }),
    })
    expect(status).toBe(200)
    expect(body.operations[0].operation).toBe("create")
  })

  test("GET /health serves the same route without the /api prefix", async () => {
    const { status, body } = await call("/health")
    expect(status).toBe(200)
    expect(body.status).toBe("ok")
  })

  test("POST /api/decode answers 400 for the pre-UDC struct format", async () => {
    // The 0xba8ccf92 execute() is no Arkiv call on a UDC chain, so it is refused like any other.
    const { status, body } = await call("/api/decode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: `0xba8ccf92${"00".repeat(64)}` }),
    })
    expect(status).toBe(400)
    expect(body.error).toBeString()
    // Generic: the refusal quotes nothing of the input.
    expect(body.error).not.toContain("ba8ccf92")
  })

  test("POST /api/decode accepts raw hex as text body", async () => {
    const data = encodeExecute([deleteOp(ENTITY_KEY)])
    const { status, body } = await call("/api/decode", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: data,
    })
    expect(status).toBe(200)
    expect(body.operations[0].operation).toBe("delete")
  })

  test("GET /api/decode?data=... works", async () => {
    const data = encodeExecute([deleteOp(ENTITY_KEY)])
    const { status, body } = await call(`/api/decode?data=${data}`)
    expect(status).toBe(200)
    expect(body.operations[0].operation).toBe("delete")
  })

  test("POST /api/decode with invalid hex returns 400", async () => {
    const { status, body } = await call("/api/decode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: "0xdeadbeef" }),
    })
    expect(status).toBe(400)
    expect(body.error).toBeString()
  })

  test("POST /api/decode with malformed JSON returns 400", async () => {
    const { status } = await call("/api/decode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    })
    expect(status).toBe(400)
  })

  test("POST /api/decode without data returns 400", async () => {
    const { status, body } = await call("/api/decode", { method: "POST" })
    expect(status).toBe(400)
    expect(body.error).toContain("Missing transaction data")
  })

  test("POST /api/decode with odd-length hex returns 400", async () => {
    const { status, body } = await call("/api/decode", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: `${encodeExecute([deleteOp(ENTITY_KEY)])}0`,
    })
    expect(status).toBe(400)
    expect(body.error).toContain("even")
  })

  test("a body declared larger than the limit is refused unread with 413", async () => {
    const { status, body } = await call("/api/decode", {
      method: "POST",
      headers: { "content-type": "text/plain", "content-length": String(MAX_BODY_BYTES + 1) },
      body: "0x",
    })
    expect(status).toBe(413)
    expect(body.error).toContain(`${MAX_BODY_BYTES}`)
  })

  test("a streamed body is cut off at the limit with 413", async () => {
    let sent = 0
    const chunk = new TextEncoder().encode("0".repeat(64 * 1024))
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Endless unless the reader stops: the server must stop reading.
        sent += chunk.length
        controller.enqueue(chunk)
        if (sent > 64 * MAX_BODY_BYTES) controller.close()
      },
    })
    const { status } = await call("/api/decode", { method: "POST", headers: { "content-type": "text/plain" }, body: stream })
    expect(status).toBe(413)
    expect(sent).toBeLessThan(2 * MAX_BODY_BYTES)
  })

  test("a body at the limit's scale is read: the largest calldata the node takes fits", async () => {
    const data = encodeExecute([
      createOp({ minLifetime: 10n, attributes: [bytesCell("a", new Uint8Array(128 * 1024))] }),
      createOp({ minLifetime: 10n, attributes: [bytesCell("b", new Uint8Array(128 * 1024))] }),
      createOp({ minLifetime: 10n, attributes: [bytesCell("c", new Uint8Array(120 * 1024))] }),
    ])
    const payload = JSON.stringify({ data, chainId: 7706815 })
    expect(payload.length).toBeLessThan(MAX_BODY_BYTES)
    const { status, body } = await call("/api/decode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    })
    expect(status).toBe(200)
    expect(body.operations).toHaveLength(3)
  })

  test("an internal error is a 500, never a 400 a caller would read as not-Arkiv", async () => {
    const spy = spyOn(decoder, "decodeArkivTransaction").mockImplementation(() => {
      throw new TypeError("a bug, not the input's fault")
    })
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      const { status, body } = await call("/api/decode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: encodeExecute([deleteOp(ENTITY_KEY)]) }),
      })
      expect(status).toBe(500)
      expect(body.error).toBe("Internal server error")
    } finally {
      spy.mockRestore()
      errors.mockRestore()
    }
  })

  test("unsupported method on /api/decode returns 405", async () => {
    const { status } = await call("/api/decode", { method: "DELETE" })
    expect(status).toBe(405)
  })

  test("unknown route returns 404", async () => {
    const { status } = await call("/nope")
    expect(status).toBe(404)
  })
})
