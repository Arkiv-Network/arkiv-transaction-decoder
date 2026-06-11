import { describe, expect, test } from "bun:test"
import { handleRequest } from "../src/server"
import { EntityOperationType } from "../src/decoder"
import { createOp, emptyOp, encodeExecute } from "./encode"

const BASE = "http://localhost"
const ENTITY_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111" as const

async function call(path: string, init?: RequestInit) {
  const res = await handleRequest(new Request(`${BASE}${path}`, init))
  // biome-ignore lint: test helper, shape is asserted per test
  return { status: res.status, body: (await res.json()) as any }
}

describe("server", () => {
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
    expect(body).toEqual({
      service: "arkiv-transaction-decoder",
      version: "v0.1.0",
    })
  })

  test("POST /api/decode decodes execute calldata from a JSON body", async () => {
    const data = encodeExecute([
      createOp({
        entityKey: ENTITY_KEY,
        payload: "Hello Arkiv",
        contentType: "text/plain",
        attributes: [{ key: "k", value: "v" }],
        expiresAtBlocks: 100,
      }),
    ])

    const { status, body } = await call("/api/decode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data }),
    })

    expect(status).toBe(200)
    expect(body.functionName).toBe("execute")
    expect(body.operations).toHaveLength(1)
    expect(body.operations[0].operation).toBe("create")
    expect(body.operations[0].payload.text).toBe("Hello Arkiv")
    expect(body.operations[0].contentType).toBe("text/plain")
    expect(body.operations[0].attributes[0]).toEqual({
      key: "k",
      valueType: 2,
      valueTypeName: "string",
      value: "v",
    })
  })

  test("POST /api/decode accepts raw hex as text body", async () => {
    const data = encodeExecute([emptyOp(EntityOperationType.Delete, ENTITY_KEY)])
    const { status, body } = await call("/api/decode", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: data,
    })
    expect(status).toBe(200)
    expect(body.operations[0].operation).toBe("delete")
  })

  test("GET /api/decode?data=... works", async () => {
    const data = encodeExecute([emptyOp(EntityOperationType.Delete, ENTITY_KEY)])
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

  test("unsupported method on /api/decode returns 405", async () => {
    const { status } = await call("/api/decode", { method: "DELETE" })
    expect(status).toBe(405)
  })

  test("unknown route returns 404", async () => {
    const { status } = await call("/nope")
    expect(status).toBe(404)
  })
})
