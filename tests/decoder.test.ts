import { describe, expect, test } from "bun:test"
import { serializeTransaction, toHex } from "viem"
import {
  ARKIV_ADDRESS,
  DecodeError,
  EXECUTE_SELECTOR,
  EntityOperationType,
  decodeArkivTransaction,
  decodeCalldata,
} from "../src/decoder"
import { createOp, emptyOp, encodeAttribute, encodeExecute } from "./encode"

const ENTITY_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111" as const
const OTHER_KEY = "0x2222222222222222222222222222222222222222222222222222222222222222" as const
const NEW_OWNER = "0xAbcd000000000000000000000000000000001234" as const

describe("decodeCalldata", () => {
  test("decodes a create operation with payload, content type and attributes", () => {
    const data = encodeExecute([
      createOp({
        entityKey: ENTITY_KEY,
        payload: "Hello Arkiv",
        contentType: "text/plain",
        attributes: [
          { key: "category", value: "greeting" },
          { key: "version", value: 42 },
        ],
        expiresAtBlocks: 1800,
      }),
    ])

    const result = decodeCalldata(data)
    expect(result.functionName).toBe("execute")
    expect(result.operations).toHaveLength(1)

    const op = result.operations[0]!
    expect(op.operation).toBe("create")
    expect(op.operationType).toBe(EntityOperationType.Create)
    expect(op.entityKey).toBe(ENTITY_KEY)
    expect(op.payload.text).toBe("Hello Arkiv")
    expect(op.payload.size).toBe(11)
    expect(op.contentType).toBe("text/plain")
    expect(op.expiresAtBlocks).toBe(1800)
    expect(op.approxExpiresInSeconds).toBe(3600)
    expect(op.newOwner).toBeNull()

    expect(op.attributes).toEqual([
      { key: "category", valueType: 2, valueTypeName: "string", value: "greeting" },
      { key: "version", valueType: 1, valueTypeName: "uint", value: "42" },
    ])
  })

  test("decodes a batch with update, delete, extend and transfer operations", () => {
    const update = createOp({
      entityKey: ENTITY_KEY,
      payload: '{"a":1}',
      contentType: "application/json",
      expiresAtBlocks: 0,
    })
    update.operationType = EntityOperationType.Update

    const extend = emptyOp(EntityOperationType.Extend, OTHER_KEY)
    extend.expiresAt = 500

    const transfer = emptyOp(EntityOperationType.Transfer, OTHER_KEY)
    transfer.newOwner = NEW_OWNER

    const data = encodeExecute([
      update,
      emptyOp(EntityOperationType.Delete, ENTITY_KEY),
      extend,
      transfer,
    ])

    const { operations } = decodeCalldata(data)
    expect(operations.map((op) => op.operation)).toEqual(["update", "delete", "extend", "transfer"])

    expect(operations[0]!.payload.text).toBe('{"a":1}')
    expect(operations[0]!.contentType).toBe("application/json")

    expect(operations[1]!.payload.size).toBe(0)
    expect(operations[1]!.contentType).toBeNull()
    expect(operations[1]!.attributes).toEqual([])

    expect(operations[2]!.expiresAtBlocks).toBe(500)

    expect(operations[3]!.newOwner).toBe(NEW_OWNER)
  })

  test("decodes binary payloads without a text field", () => {
    const data = encodeExecute([
      createOp({
        entityKey: ENTITY_KEY,
        payload: new Uint8Array([0xff, 0xfe, 0x00, 0x80]),
        contentType: "application/octet-stream",
        expiresAtBlocks: 10,
      }),
    ])

    const op = decodeCalldata(data).operations[0]!
    expect(op.payload.text).toBeUndefined()
    expect(op.payload.hex).toBe("0xfffe0080")
    expect(op.payload.size).toBe(4)
  })

  test("decodes large uint attribute values without precision loss", () => {
    const big = 2n ** 64n - 1n
    const op = createOp({
      entityKey: ENTITY_KEY,
      payload: "x",
      contentType: "text/plain",
      expiresAtBlocks: 1,
    })
    op.attributes = [encodeAttribute({ key: "big", value: big })]

    const decoded = decodeCalldata(encodeExecute([op])).operations[0]!
    expect(decoded.attributes[0]!.value).toBe(big.toString())
  })

  test("labels unknown operation types instead of misreporting them", () => {
    const op = emptyOp(99, ENTITY_KEY)
    const decoded = decodeCalldata(encodeExecute([op])).operations[0]!
    expect(decoded.operation).toBe("unknown(99)")
  })

  test("rejects calldata for a different function", () => {
    expect(() => decodeCalldata("0xa9059cbb")).toThrow(DecodeError)
  })
})

describe("decodeArkivTransaction", () => {
  test("accepts bare calldata", () => {
    const data = encodeExecute([emptyOp(EntityOperationType.Delete, ENTITY_KEY)])
    expect(data.startsWith(EXECUTE_SELECTOR)).toBe(true)
    const result = decodeArkivTransaction(data)
    expect(result.operations[0]!.operation).toBe("delete")
    expect(result.to).toBeUndefined()
  })

  test("accepts a serialized EIP-1559 transaction and reports the target", () => {
    const data = encodeExecute([emptyOp(EntityOperationType.Delete, ENTITY_KEY)])
    const serialized = serializeTransaction({
      type: "eip1559",
      chainId: 60138453025,
      to: ARKIV_ADDRESS,
      nonce: 7,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
      gas: 100_000n,
      data,
    })

    const result = decodeArkivTransaction(serialized)
    expect(result.to?.toLowerCase()).toBe(ARKIV_ADDRESS.toLowerCase())
    expect(result.warning).toBeUndefined()
    expect(result.operations[0]!.operation).toBe("delete")
  })

  test("warns when a serialized transaction targets a different contract", () => {
    const data = encodeExecute([emptyOp(EntityOperationType.Delete, ENTITY_KEY)])
    const serialized = serializeTransaction({
      type: "eip1559",
      chainId: 1,
      to: NEW_OWNER,
      nonce: 0,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      gas: 21_000n,
      data,
    })

    const result = decodeArkivTransaction(serialized)
    expect(result.warning).toContain(NEW_OWNER)
  })

  test("rejects non-hex input", () => {
    expect(() => decodeArkivTransaction("not hex")).toThrow(DecodeError)
  })

  test("rejects hex that is neither execute calldata nor a transaction", () => {
    expect(() => decodeArkivTransaction(toHex("garbage"))).toThrow(DecodeError)
  })

  test("rejects a serialized transaction calling another function", () => {
    const serialized = serializeTransaction({
      type: "eip1559",
      chainId: 1,
      to: ARKIV_ADDRESS,
      nonce: 0,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      gas: 21_000n,
      data: "0xa9059cbb0000000000000000000000000000000000000000000000000000000000000000",
    })
    expect(() => decodeArkivTransaction(serialized)).toThrow(DecodeError)
  })
})
