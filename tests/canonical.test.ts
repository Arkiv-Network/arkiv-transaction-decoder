// The node's execute() ABI layer (crates/arkiv-node/src/signed/ethereum.rs `operations`): it takes
// at most TX_CAP bytes, 1 to 128 operations of a known tag, at most 32 triples each, and only the
// canonical encoding — it re-encodes what it decoded and requires the same bytes. Anything else is
// never mined, and the decoder refuses it the same way, as a 400, before it can cost anything.
import { describe, expect, test } from "bun:test"
import { type Hex, encodeAbiParameters, parseAbiParameters, serializeTransaction, toHex } from "viem"
import {
  ARKIV_ADDRESS,
  AttributeTypeId,
  DecodeError,
  EXECUTE_SELECTOR,
  MAX_ATTRIBUTES,
  MAX_INPUT_BYTES,
  MAX_OPERATIONS,
  decodeArkivTransaction,
  decodeCalldata,
} from "../src/decoder"
import { bytesCell, cell, createOp, deleteOp, encodeExecute, strCell, transferOp, wordCell } from "./encode"

const ENTITY_KEY = `0x${"11".repeat(32)}` as Hex

/** A 32-byte word as bare hex. */
const w = (n: bigint | number) => toHex(BigInt(n), { size: 32 }).slice(2)

function refused(data: string): DecodeError {
  try {
    decodeArkivTransaction(data)
  } catch (e) {
    expect(e).toBeInstanceOf(DecodeError)
    return e as DecodeError
  }
  throw new Error("expected a DecodeError")
}

/** Replaces exactly one occurrence of a word in calldata, so a test edits the field it means. */
function replaceWord(data: Hex, from: string, to: string): string {
  const at = data.indexOf(from)
  expect(at).toBeGreaterThan(-1)
  expect(data.indexOf(from, at + 1)).toBe(-1)
  return data.slice(0, at) + to + data.slice(at + from.length)
}

/**
 * Calldata whose `ops` array points `ops` times at one operation, and whose attribute array points
 * `attributes` times at one `valueBytes`-long bytes value: small on the wire, huge if decoded by
 * following the offsets.
 */
function aliased(ops: number, attributes: number, valueBytes: number): string {
  const padded = Math.ceil(valueBytes / 32) * 32
  let create = w(0x20) + w(0) + w(0) + w(10) + w(0) + w(0xa0)
  create += w(attributes) + w(32 * attributes).repeat(attributes)
  create += toHex("body", { size: 32 }).slice(2) + w(7) + w(0x60) + w(valueBytes)
  create += "5a".repeat(valueBytes) + "00".repeat(padded - valueBytes)
  const createBytes = create.length / 2
  let data = `${EXECUTE_SELECTOR}${w(0x20)}${w(ops)}${w(32 * ops).repeat(ops)}`
  data += w(1) + w(0x40) + w(createBytes) + create + "00".repeat(Math.ceil(createBytes / 32) * 32 - createBytes)
  return data
}

describe("input bounds", () => {
  test("calldata over the node's 384 KiB cap is refused before it is read", () => {
    const tooLong = `${EXECUTE_SELECTOR}${"00".repeat(MAX_INPUT_BYTES - 3)}`
    const started = performance.now()
    expect(refused(tooLong).message).toContain(`${MAX_INPUT_BYTES}`)
    expect(performance.now() - started).toBeLessThan(50)
    expect(() => decodeCalldata(tooLong as Hex)).toThrow(DecodeError)
  })

  test("a serialized transaction over the cap is refused too", () => {
    expect(refused(`0x02${"00".repeat(MAX_INPUT_BYTES)}`).message).toContain(`${MAX_INPUT_BYTES}`)
  })

  test("calldata at the cap's scale still decodes", () => {
    // Two 128 KiB values and a third of 100 KiB: about 356 KiB of calldata.
    const data = encodeExecute([
      createOp({ minLifetime: 10n, attributes: [bytesCell("a", new Uint8Array(128 * 1024))] }),
      createOp({ minLifetime: 10n, attributes: [bytesCell("b", new Uint8Array(128 * 1024))] }),
      createOp({ minLifetime: 10n, attributes: [bytesCell("c", new Uint8Array(100 * 1024))] }),
    ])
    expect((data.length - 2) / 2).toBeLessThanOrEqual(MAX_INPUT_BYTES)
    expect(decodeCalldata(data).operations.map((op) => op.bytesSize)).toEqual([131072, 131072, 102400])
  })

  test("a call carries 1 to 128 operations", () => {
    expect(() => decodeCalldata(encodeExecute([]))).toThrow(DecodeError)
    const most = Array.from({ length: MAX_OPERATIONS }, () => deleteOp(ENTITY_KEY))
    expect(decodeCalldata(encodeExecute(most)).operations).toHaveLength(MAX_OPERATIONS)
    expect(() => decodeCalldata(encodeExecute([...most, deleteOp(ENTITY_KEY)]))).toThrow(DecodeError)
  })

  test("an operation carries at most 32 attributes", () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => strCell(`a${String(i).padStart(2, "0")}`, "x"))
    const most = decodeCalldata(encodeExecute([createOp({ minLifetime: 10n, attributes: names(MAX_ATTRIBUTES) })]))
    expect(most.operations[0]!.attributes).toHaveLength(MAX_ATTRIBUTES)
    expect(most.operations[0]!.attributes.every((a) => a.error === undefined)).toBe(true)
    expect(() =>
      decodeCalldata(encodeExecute([createOp({ minLifetime: 10n, attributes: names(MAX_ATTRIBUTES + 1) })])),
    ).toThrow(DecodeError)
  })

  test("aliased offsets are refused at once, however far they would expand", () => {
    // Each of these is a few KB to 64 KB on the wire. Followed naively, they decode into
    // hundreds of MB: the first one OOM-killed a 1 GiB container.
    for (const [ops, attributes, valueBytes] of [
      [1, 1000, 32768],
      [400, 1000, 32],
      [1, 2, 32],
      [2, 1, 32],
    ] as const) {
      const data = aliased(ops, attributes, valueBytes)
      const started = performance.now()
      refused(data)
      expect(performance.now() - started).toBeLessThan(50)
    }
  })
})

describe("canonical encoding", () => {
  const strCreate = encodeExecute([createOp({ minLifetime: 10n, attributes: [strCell("a", "hi")] })])
  const flagsCreate = encodeExecute([createOp({ salt: 0x5a5a5an, expiresAt: 0x7777n, minLifetime: 0x6666n, creationFlags: 3 })])

  test("a uint8 typeId with bits above 8 is refused, not truncated into another type", () => {
    // 2**32 + 0x88 once read as an indexed str.
    refused(replaceWord(strCreate, w(0x88), w(2n ** 32n + 0x88n)))
    refused(replaceWord(strCreate, w(0x88), w(0x188)))
  })

  test("salt, expiry, lifetime and flags must fit their widths", () => {
    expect(decodeCalldata(flagsCreate).operations[0]!.salt).toBe(`${0x5a5a5a}`)
    refused(replaceWord(flagsCreate, w(0x5a5a5a), w(2n ** 128n)))
    refused(replaceWord(flagsCreate, w(0x5a5a5a), w(2n ** 255n)))
    refused(replaceWord(flagsCreate, w(0x7777), w(2n ** 64n + 5n)))
    refused(replaceWord(flagsCreate, w(0x6666), w(2n ** 200n)))
    refused(replaceWord(flagsCreate, w(3) + w(0xa0), w(0x103) + w(0xa0)))
  })

  test("an operation tag must fit a uint8", () => {
    const data = encodeExecute([deleteOp(ENTITY_KEY)])
    refused(replaceWord(data, w(5) + w(0x40), w(0x105) + w(0x40)))
  })

  test("an address must fit 20 bytes", () => {
    const data = encodeExecute([transferOp({ entityKey: ENTITY_KEY, newOwner: ARKIV_ADDRESS })])
    refused(replaceWord(data, `000000000000000000000000${ARKIV_ADDRESS.slice(2)}`, `0000000000000000000000ff${ARKIV_ADDRESS.slice(2)}`))
  })

  test("trailing data, after the call or inside an operation, is refused", () => {
    refused(`${strCreate}deadbeef`)
    refused(`${strCreate}${"00".repeat(32)}`)
    // A delete whose operationData carries an extra word after its key.
    const padded = encodeExecute([{ operation: 5, operationData: `${ENTITY_KEY}${"00".repeat(32)}` as Hex }])
    refused(padded)
  })

  test("a bytes value must be zero-padded", () => {
    const data = encodeExecute([createOp({ minLifetime: 10n, attributes: [bytesCell("b", "0xab")] })])
    refused(replaceWord(data, `ab${"00".repeat(31)}`, `ab${"00".repeat(30)}01`))
  })

  test("an offset must be where the canonical encoding puts it", () => {
    // Point the ops array one word further on; the words in between are zero.
    const data = encodeExecute([deleteOp(ENTITY_KEY)])
    refused(`${EXECUTE_SELECTOR}${w(0x40)}${"00".repeat(32)}${data.slice(10 + 64)}`)
    // A huge offset or length is refused without being followed.
    refused(`${EXECUTE_SELECTOR}${w(2n ** 255n)}`)
    refused(`${EXECUTE_SELECTOR}${w(0x20)}${w(2n ** 255n)}`)
    refused(`${EXECUTE_SELECTOR}${w(0x20)}${w(1_000_000)}${w(0).repeat(64)}`)
  })

  test("operation data must be the struct its tag selects, exactly", () => {
    // A create tag over an extend's struct, and a create cut short.
    const extend = encodeAbiParameters(parseAbiParameters("(bytes32 entityKey, uint64 expiresAt, uint64 minLifetime)"), [
      { entityKey: ENTITY_KEY, expiresAt: 5n, minLifetime: 6n },
    ])
    refused(encodeExecute([{ operation: 1, operationData: extend }]))
    refused(encodeExecute([{ operation: 1, operationData: toHex("thirty-one bytes of content!!!!") }]))
  })

  test("hex must be 0x-prefixed and a whole number of bytes", () => {
    const data = encodeExecute([deleteOp(ENTITY_KEY)])
    expect(refused(`${data}0`).message).toContain("even")
    refused(`0X${data.slice(2)}`)
    refused("0xzz")
  })

  test("upper-case hex digits name the same bytes", () => {
    const data = encodeExecute([createOp({ minLifetime: 10n, attributes: [wordCell("n", AttributeTypeId.U64, 255n)] })])
    const upper = `0x${data.slice(2).toUpperCase()}`
    expect(decodeArkivTransaction(upper)).toEqual(decodeArkivTransaction(data))
  })

  test("a refusal never quotes the input or a library's message", () => {
    const secret = "5ec2e75ec2e75ec2e75ec2e75ec2e7"
    const inputs = [
      `${strCreate}${secret}00`,
      replaceWord(strCreate, w(0x88), w(2n ** 32n + 0x88n)),
      `${EXECUTE_SELECTOR}${w(0x20)}${w(2n ** 255n)}`,
      aliased(1, 1000, 32768),
      encodeExecute([{ operation: 1, operationData: toHex(`${secret}!`) }]),
      encodeExecute([{ operation: 9, operationData: `0x${secret}` as Hex }]),
      `0x02${secret}`,
      `0xa9059cbb${secret}`,
      serializeTransaction({
        type: "eip1559",
        chainId: 1,
        to: ARKIV_ADDRESS,
        nonce: 0,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
        gas: 21_000n,
        data: `0xa9059cbb${secret}`,
      }),
    ]
    for (const input of inputs) {
      const { message } = refused(input)
      expect(message).not.toContain(secret.slice(0, 8))
      expect(message.replaceAll(EXECUTE_SELECTOR, "")).not.toMatch(/[0-9a-f]{8}/i)
      expect(message.toLowerCase()).not.toContain("viem")
      expect(message).not.toContain("\n")
    }
  })
})

describe("cell is exported for malformed fixtures", () => {
  test("a triple built by hand still goes through the canonical reader", () => {
    const data = encodeExecute([createOp({ minLifetime: 10n, attributes: [cell("raw", 0x0b, "0x01")] })])
    expect(decodeCalldata(data).operations[0]!.attributes[0]!.type).toBe("invalid(0x0b)")
  })
})
