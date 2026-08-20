import { getAddress, isAddress } from "viem"
import type { Address } from "viem"
import { EXECUTE_V2_SELECTOR, REGISTRY_SIGNATURES } from "./abi"
import {
  DecodeError,
  type DecodeOptions,
  KNOWN_SELECTORS,
  LEGACY_EXECUTE_SELECTOR,
  UnknownSelectorError,
  decodeArkivTransaction,
  decoderGaps,
} from "./decoder"
import { SERVICE_NAME, SERVICE_VERSION } from "./version"

/** Cap on a single decode request, matching the Rust service default. */
export const MAX_INPUT_BYTES = Number(process.env.MAX_INPUT_BYTES ?? 2 * 1024 * 1024)

const USAGE = {
  service: SERVICE_NAME,
  version: SERVICE_VERSION,
  endpoints: {
    "GET /api/health": "liveness check",
    "GET /api/version": "service version",
    "GET /api/selectors": "selectors this service decodes",
    "POST /api/decode": 'body: {"data": "0x..."} (execute() calldata or serialized tx), or raw hex as text/plain',
    "GET /api/decode?data=0x...": "same as POST, via query parameter",
  },
}

const SELECTOR_INFO = [
  {
    selector: EXECUTE_V2_SELECTOR,
    signature: "execute((uint8,bytes)[])",
    abi: "v2",
    decodes: true,
  },
  {
    selector: LEGACY_EXECUTE_SELECTOR,
    signature:
      "execute((uint8,bytes32,bytes,(bytes32[4]),(bytes32,uint8,bytes32[4])[],uint32,address)[])",
    abi: "legacy",
    decodes: true,
  },
  ...Object.entries(REGISTRY_SIGNATURES)
    .filter(([signature]) => signature !== "execute((uint8,bytes)[])")
    .map(([signature, selector]) => ({ selector, signature, abi: "v2", decodes: false })),
]

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function parseBlockNumber(raw: unknown): bigint | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw) || raw < 0) throw new RequestError(400, "BAD_REQUEST", "blockNumber must be a non-negative integer")
    return BigInt(raw)
  }
  if (typeof raw !== "string") throw new RequestError(400, "BAD_REQUEST", "blockNumber must be a number or a string")
  try {
    const value = BigInt(raw)
    if (value < 0n) throw new Error("negative")
    return value
  } catch {
    throw new RequestError(400, "BAD_REQUEST", `blockNumber ${raw} is not a decimal or 0x-prefixed integer`)
  }
}

function parseTo(raw: unknown): Address | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== "string" || !isAddress(raw)) {
    throw new RequestError(400, "BAD_REQUEST", "to must be a 20-byte hex address")
  }
  return getAddress(raw)
}

function parseChainId(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined
  const value = typeof raw === "string" ? Number(raw) : raw
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RequestError(400, "BAD_REQUEST", "chainId must be a non-negative integer")
  }
  return value
}

type DecodeRequest = { data: string | null; options: DecodeOptions; chainId?: number }

async function extractRequest(req: Request, url: URL): Promise<DecodeRequest> {
  if (req.method === "GET") {
    const data = url.searchParams.get("data")
    if (data !== null && data.length > MAX_INPUT_BYTES) throw tooLarge(data.length)
    return {
      data,
      options: {
        to: parseTo(url.searchParams.get("to")),
        blockNumber: parseBlockNumber(url.searchParams.get("blockNumber")),
      },
      chainId: parseChainId(url.searchParams.get("chainId")),
    }
  }

  const declared = Number(req.headers.get("content-length") ?? 0)
  if (declared > MAX_INPUT_BYTES) throw tooLarge(declared)

  const contentType = req.headers.get("content-type") ?? ""
  const body = await req.text()
  if (body.length > MAX_INPUT_BYTES) throw tooLarge(body.length)
  if (!body) return { data: null, options: {} }

  if (contentType.includes("application/json")) {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      throw new DecodeError("Request body is not valid JSON")
    }
    if (typeof parsed !== "object" || parsed === null || typeof (parsed as { data?: unknown }).data !== "string") {
      throw new DecodeError('JSON body must have the shape {"data": "0x..."}')
    }
    // Unknown fields are ignored on purpose: arkiv-chain-indexer already sends chainId.
    const fields = parsed as { data: string; to?: unknown; blockNumber?: unknown; chainId?: unknown }
    return {
      data: fields.data,
      options: { to: parseTo(fields.to), blockNumber: parseBlockNumber(fields.blockNumber) },
      chainId: parseChainId(fields.chainId),
    }
  }

  // raw hex posted as text/plain or without a content type
  return { data: body, options: {} }
}

function tooLarge(size: number): RequestError {
  return new RequestError(
    413,
    "INPUT_TOO_LARGE",
    `Input is ${size} bytes, above the ${MAX_INPUT_BYTES} byte limit`,
  )
}

/**
 * Calldata reaches this service from a public chain, so its bytes belong to whoever sent
 * the transaction. They never choose the status code.
 *
 * arkiv-chain-indexer maps 400 to "not an Arkiv call, skip it" and throws on every other
 * status, and its caller then retries the same block forever. So a stranger who can make
 * this service answer 422 or 501 can stop the indexer for good, and the transaction that
 * does it need not even succeed on chain: a reverted transaction is still in the block.
 *
 * Hence exactly two answers to calldata: 400 when it is not ours (the caller skips it),
 * and 200 with an `undecodable` marker when it is ours but we could not read it (the
 * caller records a row). The loud channel is the log line and the counter, never the
 * status. Everything else that returns a failing status is a fault in the request
 * itself: bad JSON, a bad `to`, a body above the cap, the wrong method.
 */
function decodeErrorResponse(e: DecodeError): Response {
  const body: Record<string, unknown> = { error: e.message, code: e.code }

  if (e instanceof UnknownSelectorError) {
    body.selector = e.selector
    body.targetIsRegistry = e.targetIsRegistry
    body.knownSelectors = KNOWN_SELECTORS
  }
  return json(body, 400)
}

async function handleDecode(req: Request, url: URL): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ error: "Method not allowed", code: "METHOD_NOT_ALLOWED" }, 405)
  }
  try {
    const { data, options, chainId } = await extractRequest(req, url)
    if (!data) {
      return json(
        { error: 'Missing transaction data: pass {"data": "0x..."} or ?data=0x...', code: "BAD_REQUEST" },
        400,
      )
    }
    const decoded = decodeArkivTransaction(data, options)
    return json(chainId === undefined ? decoded : { ...decoded, chainId })
  } catch (e) {
    if (e instanceof RequestError) return json({ error: e.message, code: e.code }, e.status)
    if (e instanceof DecodeError) return decodeErrorResponse(e)
    console.error("Unexpected error while decoding:", e)
    return json({ error: "Internal server error", code: "INTERNAL_ERROR" }, 500)
  }
}

export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url)

  if (url.pathname === "/" && req.method === "GET") {
    return json(USAGE)
  }

  // /healthz and /decode mirror the Rust service's paths so this can replace it
  // without a config change on the caller.
  if ((url.pathname === "/api/health" || url.pathname === "/healthz") && req.method === "GET") {
    return json({ status: "ok" })
  }

  if (url.pathname === "/api/version" && req.method === "GET") {
    return json({ service: SERVICE_NAME, version: SERVICE_VERSION })
  }

  if ((url.pathname === "/api/selectors" || url.pathname === "/selectors") && req.method === "GET") {
    return json({ selectors: SELECTOR_INFO, maxInputBytes: MAX_INPUT_BYTES })
  }

  if (url.pathname === "/api/decode" || url.pathname === "/decode") {
    return handleDecode(req, url)
  }

  return json({ error: "Not found", code: "NOT_FOUND" }, 404)
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000)
  const server = Bun.serve({ port, fetch: handleRequest })
  console.log(`arkiv-transaction-decoder listening on http://localhost:${server.port}`)
}
