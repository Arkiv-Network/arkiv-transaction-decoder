import { DecodeError, decodeArkivTransaction } from "./decoder"
import { SERVICE_NAME, SERVICE_VERSION } from "./version"

const USAGE = {
  service: SERVICE_NAME,
  version: SERVICE_VERSION,
  endpoints: {
    "GET /api/health": "liveness check",
    "GET /api/version": "service version",
    "POST /api/decode": 'body: {"data": "0x..."} (execute() calldata or serialized tx), or raw hex as text/plain',
    "GET /api/decode?data=0x...": "same as POST, via query parameter",
  },
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  })
}

async function extractData(req: Request, url: URL): Promise<string | null> {
  if (req.method === "GET") {
    return url.searchParams.get("data")
  }
  const contentType = req.headers.get("content-type") ?? ""
  const body = await req.text()
  if (!body) return null
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
    return (parsed as { data: string }).data
  }
  // raw hex posted as text/plain or without a content type
  return body
}

export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url)

  if (url.pathname === "/" && req.method === "GET") {
    return json(USAGE)
  }

  if (url.pathname === "/api/health" && req.method === "GET") {
    return json({ status: "ok" })
  }

  if (url.pathname === "/api/version" && req.method === "GET") {
    return json({ service: SERVICE_NAME, version: SERVICE_VERSION })
  }

  if (url.pathname === "/api/decode") {
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
      console.error("Unexpected error while decoding:", e)
      return json({ error: "Internal server error" }, 500)
    }
  }

  return json({ error: "Not found" }, 404)
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000)
  const server = Bun.serve({ port, fetch: handleRequest })
  console.log(`arkiv-transaction-decoder listening on http://localhost:${server.port}`)
}
