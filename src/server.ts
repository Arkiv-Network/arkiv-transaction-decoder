import { DecodeError, MAX_INPUT_BYTES, decodeArkivTransaction } from "./decoder"
import { SERVICE_NAME, SERVICE_VERSION } from "./version"

/**
 * The largest request body read. The largest input the node accepts is MAX_INPUT_BYTES, which is
 * twice that in hex; this leaves room for the JSON around it and refuses anything far beyond.
 */
export const MAX_BODY_BYTES = 1024 * 1024

class BodyTooLarge extends Error {}

const USAGE = {
  service: SERVICE_NAME,
  version: SERVICE_VERSION,
  endpoints: {
    "GET /api/health": "liveness check",
    "GET /api/version": "service version",
    "POST /api/decode":
      'body: {"data": "0x..."} (execute() calldata or serialized tx), or raw hex as text/plain; answers the UDC operations, never bytes contents',
    "GET /api/decode?data=0x...": "same as POST, via query parameter",
  },
  note: "the /api prefix is optional: /decode is the same route as /api/decode",
  limits: `input at most ${MAX_INPUT_BYTES} bytes (the node's transaction cap), request body at most ${MAX_BODY_BYTES} bytes`,
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/**
 * Reads the body, but no more than MAX_BODY_BYTES of it: a declared length beyond that is refused
 * unread, and a body that turns out longer is cut off as soon as it does. Bun.serve enforces the
 * same limit; this keeps handleRequest bounded whoever calls it.
 */
async function readBody(req: Request): Promise<string> {
  const declared = Number(req.headers.get("content-length"))
  if (declared > MAX_BODY_BYTES) throw new BodyTooLarge()
  if (!req.body) return ""
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BODY_BYTES) {
      await reader.cancel()
      throw new BodyTooLarge()
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

async function extractData(req: Request, url: URL): Promise<string | null> {
  if (req.method === "GET") {
    return url.searchParams.get("data")
  }
  const contentType = req.headers.get("content-type") ?? ""
  const body = await readBody(req)
  if (!body) return null
  if (contentType.includes("application/json")) {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      throw new DecodeError("Request body is not valid JSON")
    }
    // Only `data` is read: callers such as the chain indexer also send a `chainId`, which decoding
    // calldata does not need.
    if (typeof parsed !== "object" || parsed === null || typeof (parsed as { data?: unknown }).data !== "string") {
      throw new DecodeError('JSON body must have the shape {"data": "0x..."}')
    }
    return (parsed as { data: string }).data
  }
  // raw hex posted as text/plain or without a content type
  return body
}

export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url)
  // Served both behind a gateway that mounts it under /api and directly by service-to-service
  // callers that post to <base>/decode, so the prefix is optional on every route.
  const path = url.pathname.replace(/^\/api(?=\/|$)/, "") || "/"

  if (path === "/" && req.method === "GET") {
    return json(USAGE)
  }

  if (path === "/health" && req.method === "GET") {
    return json({ status: "ok" })
  }

  if (path === "/version" && req.method === "GET") {
    return json({ service: SERVICE_NAME, version: SERVICE_VERSION })
  }

  if (path === "/decode") {
    if (req.method !== "GET" && req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405)
    }
    try {
      const data = await extractData(req, url)
      if (!data) {
        return json({ error: 'Missing transaction data: pass {"data": "0x..."} or ?data=0x...' }, 400)
      }
      return json(decodeArkivTransaction(data))
    } catch (e) {
      if (e instanceof DecodeError) {
        return json({ error: e.message }, 400)
      }
      if (e instanceof BodyTooLarge) {
        return json({ error: `Request body is larger than ${MAX_BODY_BYTES} bytes` }, 413)
      }
      console.error("Unexpected error while decoding:", e)
      return json({ error: "Internal server error" }, 500)
    }
  }

  return json({ error: "Not found" }, 404)
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000)
  const server = Bun.serve({ port, fetch: handleRequest, maxRequestBodySize: MAX_BODY_BYTES })
  console.log(`arkiv-transaction-decoder listening on http://localhost:${server.port}`)
}
