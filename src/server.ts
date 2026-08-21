import { getAddress, isAddress } from "viem"
import type { Address } from "viem"
import {
  EXECUTE_SELECTOR,
  REGISTRY_SIGNATURES,
  RETIRED_EXECUTE_SELECTOR,
  RETIRED_EXECUTE_SIGNATURE,
} from "./abi"
import type { DecodeOptions } from "./decode"
import { KNOWN_SELECTORS, decodeArkivTransaction } from "./decoder"
import { DecodeError, type DecoderGapCode, UnknownSelectorError, decoderGaps, recordGap } from "./gaps"
import { SERVICE_NAME, SERVICE_VERSION } from "./version"

/**
 * Cap on a single decode request, and the floor under that cap.
 *
 * The cap stays, because memory has to be bounded: without it, one request makes this
 * service buffer whatever a sender chose to put on chain. What changed is the answer.
 * Crossing it used to be 413, and the body size is picked by whoever sent the transaction,
 * not by the caller, so it was a halt anyone could buy. It is a recorded gap at 200 now.
 * See CALLDATA_STATUS.
 *
 * SIZE IT FROM THE TRANSACTION CAP, NOT FROM MAX_PAYLOAD_BYTES. The protocol's per-payload
 * limit says nothing about what fits in a transaction, and reasoning from it invents bodies
 * the chain cannot carry: "eight creates each at MAX_PAYLOAD_BYTES" is a 2.1 MB body, and
 * no such transaction exists, because the envelope caps things an order of magnitude lower.
 * The binding limit is the txpool's. arkiv-op-node core/txpool/legacypool/legacypool.go:54-61
 * sets txSlotSize = 32 * 1024 and
 *     // txMaxSize = 16 * txSlotSize // 512KB
 *     txMaxSize = 4 * txSlotSize // 128KB
 * so 128 KB is the ceiling today and the commented line directly above it says a raise to
 * 512 KB is already contemplated. Nothing bigger than one whole transaction can arrive:
 * arkiv-chain-indexer forwards one transaction's calldata per request.
 *
 * The arithmetic, taken at the contemplated 512 KB rather than today's 128 KB:
 *     a transaction                              524,288 bytes
 *     hex-encoded, "0x" plus two chars per byte  1,048,578
 *     inside {"data":"0x...","chainId":7733102}  1,048,607
 *     rounded up to a power of two               2 MiB = 2,097,152
 * So 2 MiB is 2x the contemplated worst case and 8x today's, since a 128 KB transaction is
 * a 262,175 byte body. Measured on cheesecake, 395 registry transactions across three busy
 * block regions ran to a maximum of 83,268 bytes of transaction, a third of today's cap.
 *
 * MIN_INPUT_BYTES is that same 2 MiB, so this knob only goes up. A cap below what the chain
 * can produce is not a smaller memory budget, it is a halted scanner: real transactions come
 * back INPUT_TOO_LARGE, and below the handler Bun answers 413 on its own (maxRequestBodySize
 * at the foot of this file), which is the status the caller cannot survive. A misconfigured
 * decoder that runs is worse than one that does not, so a value under the floor refuses to
 * start.
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

/** The smallest cap that still fits every transaction this chain can produce. See above. */
export const MIN_INPUT_BYTES = 2 * 1024 * 1024

export const MAX_INPUT_BYTES = byteCapFromEnv("MAX_INPUT_BYTES", MIN_INPUT_BYTES)

if (MAX_INPUT_BYTES < MIN_INPUT_BYTES) {
  // Loud and terminal on purpose. Starting anyway would answer ordinary chain traffic with
  // INPUT_TOO_LARGE, or let Bun answer 413 under us, and either one wedges the scanner on a
  // block it will retry forever. Refusing here is a page; a wedged scanner is a mystery.
  console.error(
    `MAX_INPUT_BYTES=${MAX_INPUT_BYTES} is below the ${MIN_INPUT_BYTES} byte minimum, so this decoder would ` +
      "refuse transactions the chain can produce. A transaction is capped at 131072 bytes today (txMaxSize, " +
      "arkiv-op-node core/txpool/legacypool/legacypool.go:61) with 524288 contemplated, which is a 1048607 " +
      "byte JSON body once hex-encoded. Unset MAX_INPUT_BYTES or set it to at least " +
      `${MIN_INPUT_BYTES}. Refusing to start.`,
  )
  process.exit(1)
}

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
  { selector: EXECUTE_SELECTOR, signature: "execute((uint8,bytes)[])", decodes: true },
  ...Object.entries(REGISTRY_SIGNATURES)
    .filter(([signature]) => signature !== "execute((uint8,bytes)[])")
    .map(([signature, selector]) => ({ selector, signature, decodes: false })),
  // Listed so an operator can tell a selector this build retired from one it never knew.
  // Both answer with zero operations; only this one means a chain is running an ABI we
  // deleted, and the RETIRED_GENERATION tally next to it is the count that says so.
  {
    selector: RETIRED_EXECUTE_SELECTOR,
    signature: RETIRED_EXECUTE_SIGNATURE,
    decodes: false,
    retired: true,
  },
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
    // framework ceiling has to stay above ours: every body a transaction can produce must
    // reach handleRequest and come back as a 200 gap. Never set this to MAX_INPUT_BYTES.
    //
    // Derived rather than pinned to a constant, and that direction matters. The floor
    // already holds the low end: MAX_INPUT_BYTES cannot go under 2 MiB, so this cannot go
    // under 4 MiB, which is above anything the chain can send. A pinned constant would
    // instead break at the high end, because an operator who raises MAX_INPUT_BYTES past
    // the pin puts Bun's 413 back underneath the handler, which is the halt this whole file
    // exists to prevent. Deriving keeps the ceiling above the cap at every legal value.
    maxRequestBodySize: MAX_INPUT_BYTES * 2,
    fetch: handleRequest,
  })
  console.log(`arkiv-transaction-decoder listening on http://localhost:${server.port}`)
}
