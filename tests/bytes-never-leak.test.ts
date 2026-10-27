// Property: no response ever carries the content of a `bytes` value — not as hex, not as text, not
// as base64, not in part — whatever the batch around it, whatever route it came through, and
// whether or not the triple is well formed.
import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { type Hex, decodeAbiParameters, decodeFunctionData, parseAbiParameters, serializeTransaction, toHex } from "viem"
import { ARKIV_ADDRESS, AttributeTypeId, EXECUTE_ABI, INDEXED_FLAG, decodeArkivTransaction } from "../src/decoder"
import { handleRequest } from "../src/server"
import {
  type AbiAttribute,
  type Operation,
  bytesCell,
  cell,
  createOp,
  deleteOp,
  encodeExecute,
  extendOp,
  patchOp,
  strCell,
  tombstoneCell,
  transferOp,
  wordCell,
} from "./encode"

const CREATE_PARAMS = parseAbiParameters(
  "(uint128 salt, uint64 expiresAt, uint64 minLifetime, uint8 creationFlags, (bytes32 name, uint8 typeId, bytes value)[] attributes)",
)
const PATCH_PARAMS = parseAbiParameters("(bytes32 entityKey, (bytes32 name, uint8 typeId, bytes value)[] mutations)")

const ATTRIBUTE_KEYS = new Set(["name", "typeId", "type", "indexed", "value", "size", "keccak256", "error"])

// mulberry32: a small seeded generator, so a failure reproduces.
function generator(seed: number) {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (max: number) => Math.floor(next() * max)
  const bytes = (length: number) => Uint8Array.from({ length }, () => int(256))
  return { next, int, bytes }
}

const textEncoder = new TextEncoder()

/**
 * A bytes content that is also readable as text, which a decoder might be tempted to render. It
 * repeats a marker no other part of a response can hold, so finding the marker means a leak.
 */
function textContent(random: ReturnType<typeof generator>, length: number): { content: Uint8Array; marker: string } {
  const marker = `secret-${random.int(1e9)}-`
  const text = `{"doc":"${marker.repeat(Math.ceil(length / marker.length) + 1)}"}`
  return { content: textEncoder.encode(text.slice(0, Math.max(length, 8 + marker.length))), marker }
}

function hexOf(bytes: Uint8Array): string {
  return toHex(bytes).slice(2)
}

/**
 * Asserts `response` holds no trace of `content`: neither its hex nor any 8-byte window of it (in
 * either case), nor its base64, nor its whole text. Text is not checked window by window: a
 * document may legitimately share words with the attributes beside it.
 */
function expectNoTrace(response: string, content: Uint8Array) {
  const lower = response.toLowerCase()
  const hex = hexOf(content)
  if (content.length >= 4) expect(lower.includes(hex)).toBe(false)
  for (let i = 0; i + 8 <= content.length; i += 4) {
    expect(lower.includes(hex.slice(2 * i, 2 * (i + 8)))).toBe(false)
  }
  if (content.length >= 6) expect(response.includes(Buffer.from(content).toString("base64"))).toBe(false)
  const text = new TextDecoder().decode(content)
  if (text.length >= 12 && !text.includes("\uFFFD")) expect(response.includes(text)).toBe(false)
}

/** Every attribute a response carries has the contract's keys only, and no value for bytes. */
function expectBytesStructurallyAbsent(response: unknown) {
  const body = response as { operations: { attributes: Record<string, unknown>[] }[] }
  for (const op of body.operations) {
    for (const attribute of op.attributes) {
      for (const key of Object.keys(attribute)) expect(ATTRIBUTE_KEYS.has(key)).toBe(true)
      if (((attribute.typeId as number) & ~INDEXED_FLAG) === AttributeTypeId.Bytes) {
        expect(attribute.value).toBeNull()
      }
    }
  }
}

const NAMES = ["body", "cover", "thumb", "blob", "Data", "x.y", "z-1", "q_2"]

function randomBatch(random: ReturnType<typeof generator>) {
  const contents: Uint8Array[] = []
  const markers: string[] = []
  const randomCells = (allowTombstones: boolean): AbiAttribute[] => {
    const cells: AbiAttribute[] = []
    const count = 1 + random.int(6)
    for (let i = 0; i < count; i++) {
      const name = `${NAMES[random.int(NAMES.length)]}${i}`
      const pick = random.next()
      if (pick < 0.5) {
        const length = random.next() < 0.1 ? 8 * 1024 + random.int(32 * 1024) : random.int(512)
        let content: Uint8Array
        if (random.next() < 0.3) {
          const text = textContent(random, length)
          content = text.content
          markers.push(text.marker)
        } else {
          content = random.bytes(length)
        }
        contents.push(content)
        // Mostly well formed; sometimes with the indexed flag the node refuses on bytes.
        const typeId = random.next() < 0.15 ? AttributeTypeId.Bytes | INDEXED_FLAG : AttributeTypeId.Bytes
        cells.push(random.next() < 0.85 && typeId === AttributeTypeId.Bytes ? bytesCell(name, content) : cell(name, typeId, toHex(content)))
      } else if (pick < 0.65) {
        cells.push(strCell(name, `s${random.int(1000)}`, random.next() < 0.5))
      } else if (pick < 0.8) {
        cells.push(wordCell(name, AttributeTypeId.U64, BigInt(random.int(1e9)), random.next() < 0.5))
      } else if (pick < 0.9 && allowTombstones) {
        cells.push(tombstoneCell(name))
      } else {
        cells.push(wordCell(name, AttributeTypeId.Key, BigInt(random.int(1e9))))
      }
    }
    return cells
  }
  const key = toHex(random.bytes(32))
  const ops: Operation[] = []
  const count = 1 + random.int(5)
  for (let i = 0; i < count; i++) {
    const pick = random.int(5)
    if (pick === 0 || pick === 1) {
      ops.push(createOp({ salt: BigInt(random.int(1e9)), minLifetime: 100n, attributes: randomCells(false) }))
    } else if (pick === 2) {
      ops.push(patchOp({ entityKey: key, mutations: randomCells(true) }))
    } else if (pick === 3) {
      ops.push(extendOp({ entityKey: key, minLifetime: BigInt(random.int(1e6)) }))
    } else {
      ops.push(random.next() < 0.5 ? deleteOp(key) : transferOp({ entityKey: key, newOwner: ARKIV_ADDRESS }))
    }
  }
  return { calldata: encodeExecute(ops), contents, markers }
}

async function decodeOverHttp(data: Hex): Promise<string> {
  const response = await handleRequest(
    new Request("http://localhost/decode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data }),
    }),
  )
  expect(response.status).toBe(200)
  return response.text()
}

describe("bytes content never appears in a response", () => {
  test("random batches, as calldata, over HTTP and as a serialized transaction", async () => {
    const random = generator(0x5eed)
    for (let round = 0; round < 150; round++) {
      const { calldata, contents, markers } = randomBatch(random)
      const direct = JSON.stringify(decodeArkivTransaction(calldata))
      const http = await decodeOverHttp(calldata)
      const serialized = JSON.stringify(
        decodeArkivTransaction(
          serializeTransaction({
            type: "eip1559",
            chainId: 7706815,
            to: ARKIV_ADDRESS,
            nonce: round,
            maxFeePerGas: 1_000_000_000n,
            maxPriorityFeePerGas: 0n,
            gas: 1_000_000n,
            data: calldata,
          }),
        ),
      )
      for (const response of [direct, http, serialized]) {
        expectBytesStructurallyAbsent(JSON.parse(response))
        for (const content of contents) expectNoTrace(response, content)
        for (const marker of markers) expect(response.includes(marker)).toBe(false)
      }
    }
  })

  test("every recorded live transaction", async () => {
    const dir = `${import.meta.dir}/fixtures/live`
    const files = readdirSync(dir).filter((file) => /^block-\d+\.json$/.test(file))
    expect(files.length).toBeGreaterThan(0)
    let checked = 0
    for (const file of files) {
      const fixture = await Bun.file(`${dir}/${file}`).json()
      for (const tx of fixture.transactions as { input: Hex }[]) {
        // The bytes contents, read straight from the calldata without the decoder.
        const contents: Uint8Array[] = []
        const { args } = decodeFunctionData({ abi: EXECUTE_ABI, data: tx.input })
        for (const op of args[0]) {
          let cells: readonly { typeId: number; value: Hex }[] = []
          if (op.operation === 1) cells = decodeAbiParameters(CREATE_PARAMS, op.operationData)[0].attributes
          if (op.operation === 2) cells = decodeAbiParameters(PATCH_PARAMS, op.operationData)[0].mutations
          for (const c of cells) {
            if ((c.typeId & ~INDEXED_FLAG) === AttributeTypeId.Bytes) contents.push(Buffer.from(c.value.slice(2), "hex"))
          }
        }
        const direct = JSON.stringify(decodeArkivTransaction(tx.input))
        const http = await decodeOverHttp(tx.input)
        for (const response of [direct, http]) {
          expectBytesStructurallyAbsent(JSON.parse(response))
          for (const content of contents) expectNoTrace(response, content)
        }
        checked += contents.length
      }
    }
    // The fixtures hold bytes values worth checking: block 65's 32 KiB cover among them.
    expect(checked).toBeGreaterThan(5)
  })
})
