import { getAddress, isAddress } from "viem"
import type { Address } from "viem"
import { EXECUTE_V2_SELECTOR, LEGACY_EXECUTE_SELECTOR, REGISTRY_SIGNATURES } from "./abi"
import {
  DecodeError,
  type DecodeOptions,
  type DecoderGapCode,
  KNOWN_SELECTORS,
  UnknownSelectorError,
  decodeArkivTransaction,
  decoderGaps,
  recordGap,
} from "./decoder"
import { SERVICE_NAME, SERVICE_VERSION } from "./version"

/**
 * Cap on a single decode request.
 *
 * The cap stays, because memory has to be bounded: without it, one request makes this
 * service buffer whatever a sender chose to put on chain. What changed is the answer.
 * Crossing it used to be 413, and the body size is picked by whoever sent the transaction,
 * not by the caller, so it was a halt anyone could buy: roughly 1 MB of zero calldata to
 * the registry, about 4.2M gas at 4 gas per zero byte, and the transaction need not even
 * succeed. Ordinary valid usage reaches it too, since eight creates each carrying the
 * protocol's own MAX_PAYLOAD_BYTES is a 2.1 MB body. It is a recorded gap at 200 now.
 * See CALLDATA_STATUS.
 *
 * The default sits above what one block can physically carry, so the cap does not fire on
 * traffic a chain can actually produce. A transaction's calldata is bounded by the block
 * gas limit, and at 4 gas per zero byte a 30M gas block holds about 7.5 MB of calldata,
 * which is about 15 MB once hex-encoded into a JSON body. The old 2 MiB default sat under
 * ordinary valid usage and dropped it. Measured at 16 MiB: eight creates carrying
 * MAX_PAYLOAD_BYTES each is a 2.11 MB body that decodes in about 55 ms, and the response
 * is 5 KB, because payload hex is truncated at DEFAULT_PAYLOAD_HEX_LIMIT rather than
 * echoed. Raise it with MAX_INPUT_BYTES if INPUT_TOO_LARGE ever climbs in
 * GET /api/selectors.
 *
 * Number("2mb") is NaN, and every `size > NaN` is false, so a typo in the environment used
 * to remove the cap rather than fail. A bad value now falls back and says so.
 */
function byteCapFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    console.warn(`${name}="${raw}" is not a positive integer; using the ${fallback} byte default`)
    return fallback
  }
  return value
}

export const MAX_INPUT_BYTES = byteCapFromEnv("MAX_INPUT_BYTES", 16 * 1024 * 1024)

const USAGE = {
  service: SERVICE_NAME,
  version: SERVICE_VERSION,
  endpoints: {
    "GET /api/health": "liveness check",
    "GET /api/version": "service version",
    "GET /api/selectors": "selectors this service decodes, and every decoder gap seen since start",
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

/**
 * A fault in the request itself: bad JSON, a bad `to`, the wrong body shape. The caller's
 * bug, so it is always 400 and carries no status of its own. Nothing here is reachable by
 * choosing the bytes of a transaction.
 */
class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/**
 * The body is above the cap, so we never read the bytes.
 *
 * Deliberately not a RequestError. The size of chain calldata is chosen by whoever sent
 * the transaction, not by the caller, so it does not get to pick the status.
 */
class InputTooLarge extends Error {
  constructor(readonly size: number) {
    super(`Input is ${size} bytes, above the ${MAX_INPUT_BYTES} byte limit`)
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
    if (!Number.isSafeInteger(raw) || raw < 0) throw new RequestError("BAD_REQUEST", "blockNumber must be a non-negative integer")
    return BigInt(raw)
  }
  if (typeof raw !== "string") throw new RequestError("BAD_REQUEST", "blockNumber must be a number or a string")
  try {
    const value = BigInt(raw)
    if (value < 0n) throw new Error("negative")
    return value
  } catch {
    throw new RequestError("BAD_REQUEST", `blockNumber ${raw} is not a decimal or 0x-prefixed integer`)
  }
}

function parseTo(raw: unknown): Address | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== "string" || !isAddress(raw)) {
    throw new RequestError("BAD_REQUEST", "to must be a 20-byte hex address")
  }
  return getAddress(raw)
}

function parseChainId(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined
  const value = typeof raw === "string" ? Number(raw) : raw
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RequestError("BAD_REQUEST", "chainId must be a non-negative integer")
  }
  return value
}

/**
 * Read the body and drop it, so the connection is left clean.
 *
 * Answering before the body has been read leaves the remainder on the socket, and fetch
 * pools connections, so Bun parses those bytes as the next request's headers and answers
 * 431. Verified: without this, the same oversized body alternates 200, 431, 200, 431. A 431
 * is not 400, so the caller throws on it and retries that block forever. It is the halt
 * this file exists to prevent, arriving one request later instead.
 *
 * Chunks are dropped as they arrive, so the cap still holds and nothing accumulates.
 */
async function discardBody(req: Request): Promise<void> {
  if (req.body === null) return
  const reader = req.body.getReader()
  while (!(await reader.read()).done) {
    // dropped on purpose
  }
}

type DecodeRequest = { data: string | null; options: DecodeOptions; chainId?: number }

async function extractRequest(req: Request, url: URL): Promise<DecodeRequest> {
  if (req.method === "GET") {
    const data = url.searchParams.get("data")
    if (data !== null && data.length > MAX_INPUT_BYTES) throw new InputTooLarge(data.length)
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
  if (declared > MAX_INPUT_BYTES) {
    await discardBody(req)
    throw new InputTooLarge(declared)
  }

  const contentType = req.headers.get("content-type") ?? ""
  const body = await req.text()
  if (body.length > MAX_INPUT_BYTES) throw new InputTooLarge(body.length)
  if (!body) return { data: null, options: {} }

  if (contentType.includes("application/json")) {
    // A broken body is the caller's bug, not a classification of chain traffic. Reporting
    // it as NOT_ARKIV_CALLDATA would leave anyone counting that code to size non-Arkiv
    // traffic also counting broken clients.
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      throw new RequestError("BAD_REQUEST", "Request body is not valid JSON")
    }
    if (typeof parsed !== "object" || parsed === null || typeof (parsed as { data?: unknown }).data !== "string") {
      throw new RequestError("BAD_REQUEST", 'JSON body must have the shape {"data": "0x..."}')
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

/**
 * THE RULE THIS SERVICE IS BUILT ON. Read this before adding a status code.
 *
 * FOR ANY CALLDATA INPUT, THIS SERVICE RETURNS EXACTLY TWO STATUSES.
 *   400  this is not Arkiv calldata. The caller skips it.
 *   200  everything else, including calldata this decoder cannot read, marked undecodable.
 *
 * Loudness for the operator lives in the log line and the gap counter, NEVER in the status
 * code. Genuine client-protocol errors, a malformed JSON body or the wrong body shape, may
 * still be 400 BAD_REQUEST, because those are the caller's bug and not attacker-controlled
 * bytes.
 *
 * Why it is absolute. Calldata reaches this service from a public chain, so its bytes
 * belong to whoever sent the transaction, and a reverted transaction still sits in the
 * block. arkiv-chain-indexer maps 400 to "skip" and throws on every other status
 * (arkivOperations.ts:137-140), and scanBlockWithRetry then retries that same block forever
 * with no cap (scanner.ts:279). So any third status, on bytes a stranger picks, is a
 * permanent halt of the indexer bought for the price of one transaction.
 *
 * This has been rediscovered three times. First 422 and 501 for an operation we could not
 * read, then 413 for an oversized body, which ordinary valid usage reaches on its own.
 * Every pass expressed "be loud" as a status code, and every pass rebuilt the same halt.
 * These two are the only ones, and tests/statusInvariant.test.ts fails the build when a new
 * handler invents a third.
 */
const CALLDATA_STATUS = { DECODED: 200, NOT_OURS: 400 } as const
type CalldataStatus = (typeof CALLDATA_STATUS)[keyof typeof CALLDATA_STATUS]

/** Every answer to calldata goes through here, so that the two statuses stay two. */
function calldataResponse(body: unknown, status: CalldataStatus): Response {
  return json(body, status)
}

/**
 * Calldata we would not or could not read: a row for the caller, not a failure.
 *
 * arkiv-chain-indexer only requires `operations` to be an array, so an empty batch is an
 * answer it records and moves past. The operator gets the log line and the counter.
 */
function undecodableResponse(code: DecoderGapCode, message: string): Response {
  return calldataResponse(
    { undecodable: recordGap({ code, message }), operationCount: 0, operations: [] },
    CALLDATA_STATUS.DECODED,
  )
}

/** The 400 half of the rule: not ours, so the caller skips it. */
function decodeErrorResponse(e: DecodeError): Response {
  const body: Record<string, unknown> = { error: e.message, code: e.code }

  if (e instanceof UnknownSelectorError) {
    body.selector = e.selector
    body.targetIsRegistry = e.targetIsRegistry
    body.knownSelectors = KNOWN_SELECTORS
  }
  return calldataResponse(body, CALLDATA_STATUS.NOT_OURS)
}

async function handleDecode(req: Request, url: URL): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ error: "Method not allowed", code: "METHOD_NOT_ALLOWED" }, 405)
  }
  try {
    const { data, options, chainId } = await extractRequest(req, url)
    if (!data) {
      return calldataResponse(
        { error: 'Missing transaction data: pass {"data": "0x..."} or ?data=0x...', code: "BAD_REQUEST" },
        CALLDATA_STATUS.NOT_OURS,
      )
    }
    const decoded = decodeArkivTransaction(data, options)
    return calldataResponse(chainId === undefined ? decoded : { ...decoded, chainId }, CALLDATA_STATUS.DECODED)
  } catch (e) {
    // The body was too big to read. Its size is the sender's choice, so it is a gap, not
    // a status. chainId is not echoed here because parsing the body is what we declined.
    if (e instanceof InputTooLarge) return undecodableResponse("INPUT_TOO_LARGE", e.message)
    if (e instanceof RequestError) return calldataResponse({ error: e.message, code: e.code }, CALLDATA_STATUS.NOT_OURS)
    if (e instanceof DecodeError) return decodeErrorResponse(e)
    // A throw from the decoder is our bug, not a verdict on the bytes, and the bytes are
    // attacker-chosen. A 500 here halts the indexer exactly like the 413 did, so it goes
    // out as a loud gap instead: console.error plus a named counter on GET /api/selectors.
    console.error("Unexpected error while decoding:", e)
    return undecodableResponse(
      "DECODER_FAULT",
      `The decoder threw while reading this calldata: ${e instanceof Error ? e.message : String(e)}`,
    )
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
    // `gaps` is the operator's channel. Decoder drift cannot travel in the status code
    // without stopping the caller, so it is counted here and logged on first sight instead.
    return json({ selectors: SELECTOR_INFO, maxInputBytes: MAX_INPUT_BYTES, gaps: decoderGaps() })
  }

  if (url.pathname === "/api/decode" || url.pathname === "/decode") {
    return handleDecode(req, url)
  }

  return json({ error: "Not found", code: "NOT_FOUND" }, 404)
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000)
  const server = Bun.serve({
    port,
    // Bun answers an oversized body itself, with a 413, and never runs the handler. That
    // is the one way the two-status rule can be broken from outside this file, so the
    // framework ceiling has to stay above ours: every body a block can produce must reach
    // handleRequest and come back as a 200 gap. Never set this to MAX_INPUT_BYTES.
    maxRequestBodySize: MAX_INPUT_BYTES * 2,
    fetch: handleRequest,
  })
  console.log(`arkiv-transaction-decoder listening on http://localhost:${server.port}`)
}
