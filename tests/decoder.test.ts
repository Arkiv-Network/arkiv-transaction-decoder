import { describe, expect, test } from "bun:test"
import { serializeTransaction, toHex } from "viem"
import {
  ARKIV_ADDRESS,
  AttributeTypeId,
  DecodeError,
  EXECUTE_SELECTOR,
  EntityOperationType,
  LEGACY_EXECUTE_SELECTOR,
  decodeArkivTransaction,
  decodeCalldata,
} from "../src/decoder"
import {
  contentTypeCell,
  createOp,
  deleteOp,
  encodeExecute,
  encodeLegacyExecute,
  extendOp,
  legacyAttribute,
  legacyCreateOp,
  legacyEmptyOp,
  patchOp,
  payloadCell,
  strCell,
  tombstoneCell,
  transferOp,
  unknownOp,
  wordCell,
} from "./encode"

const ENTITY_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111" as const
const OTHER_KEY = "0x2222222222222222222222222222222222222222222222222222222222222222" as const
const NEW_OWNER = "0xAbcd000000000000000000000000000000001234" as const

describe("decodeCalldata", () => {
  test("decodes a create, lifting the system cells back into payload and content type", () => {
    const data = encodeExecute([
      createOp({
        salt: 42n,
        minLifetime: 900n,
        creationFlags: 1,
        attributes: [
          contentTypeCell("text/plain"),
          payloadCell("Hello Arkiv"),
          strCell("category", "greeting"),
          wordCell("version", AttributeTypeId.U64, 42n),
        ],
      }),
    ])

    const result = decodeCalldata(data)
    expect(result.functionName).toBe("execute")
    expect(result.format).toBe("tagged")
    expect(result.operations).toHaveLength(1)

    const op = result.operations[0]!
    expect(op.operation).toBe("create")
    expect(op.operationType).toBe(EntityOperationType.Create)
    // The engine derives a create's key from owner, nonce and salt, so calldata cannot name it.
    expect(op.entityKey).toBeNull()
    expect(op.payload.size).toBe(11)
    expect(op.contentType).toBe("text/plain")
    expect(op.expiresAtBlocks).toBe(900)
    expect(op.minLifetime).toBe(900)
    expect(op.expiresAt).toBe(0)
    expect(op.approxExpiresInSeconds).toBe(1800)
    expect(op.salt).toBe("42")
    expect(op.creationFlags).toBe(1)
    expect(op.newOwner).toBeNull()

    // $payload and $contentType are reported as fields, not as attributes.
    expect(op.attributes).toEqual([
      { key: "category", valueType: 8, valueTypeName: "str", value: "greeting" },
      { key: "version", valueType: 3, valueTypeName: "u64", value: "42" },
    ])
  })

  test("reports the payload size without ever returning the payload bytes", () => {
    const payload = new Uint8Array(4096).fill(0xab)
    const data = encodeExecute([createOp({ attributes: [payloadCell(payload)] })])

    const op = decodeCalldata(data).operations[0]!
    expect(op.payload).toEqual({ size: 4096 })
    expect(JSON.stringify(op)).not.toContain("abab")
  })

  test("decodes every attribute type the protocol defines", () => {
    const data = encodeExecute([
      createOp({
        attributes: [
          wordCell("flag", AttributeTypeId.Bool, 1n),
          wordCell("offset", AttributeTypeId.I32, -5n),
          wordCell("height", AttributeTypeId.U64, 2n ** 63n),
          wordCell("supply", AttributeTypeId.U256, 2n ** 200n),
          wordCell("price", AttributeTypeId.Dec, 3_500_000_000_000_000_000n),
          wordCell("debt", AttributeTypeId.Dec, -250_000_000_000_000_000n),
          wordCell("digest", AttributeTypeId.Bytes32, BigInt(OTHER_KEY)),
          wordCell("owner", AttributeTypeId.Addr, BigInt(NEW_OWNER)),
          wordCell("parent", AttributeTypeId.Key, BigInt(ENTITY_KEY)),
          strCell("name", "Bob"),
        ],
      }),
    ])

    const attributes = decodeCalldata(data).operations[0]!.attributes
    expect(attributes.map((attr) => [attr.key, attr.valueTypeName, attr.value])).toEqual([
      ["flag", "bool", "true"],
      ["offset", "i32", "-5"],
      ["height", "u64", (2n ** 63n).toString()],
      ["supply", "u256", (2n ** 200n).toString()],
      ["price", "dec", "3.5"],
      ["debt", "dec", "-0.25"],
      ["digest", "bytes32", OTHER_KEY],
      ["owner", "addr", NEW_OWNER],
      ["parent", "key", ENTITY_KEY],
      ["name", "str", "Bob"],
    ])
  })

  test("decodes a patch, including the tombstones that unset attributes", () => {
    const data = encodeExecute([
      patchOp({
        entityKey: ENTITY_KEY,
        mutations: [
          contentTypeCell("application/json"),
          payloadCell('{"a":1}'),
          strCell("category", "updated"),
          tombstoneCell("obsolete"),
        ],
      }),
    ])

    const op = decodeCalldata(data).operations[0]!
    expect(op.operation).toBe("update")
    expect(op.operationType).toBe(EntityOperationType.Update)
    expect(op.entityKey).toBe(ENTITY_KEY)
    expect(op.payload.size).toBe(7)
    expect(op.contentType).toBe("application/json")
    expect(op.attributes).toEqual([
      { key: "category", valueType: 8, valueTypeName: "str", value: "updated" },
      { key: "obsolete", valueType: 0, valueTypeName: "tombstone", value: "" },
    ])
  })

  test("decodes a batch of extend, transfer and delete operations", () => {
    const data = encodeExecute([
      extendOp({ entityKey: ENTITY_KEY, minLifetime: 500n }),
      transferOp({ entityKey: OTHER_KEY, newOwner: NEW_OWNER }),
      deleteOp(ENTITY_KEY),
    ])

    const { operations } = decodeCalldata(data)
    expect(operations.map((op) => op.operation)).toEqual(["extend", "transfer", "delete"])

    expect(operations[0]!.entityKey).toBe(ENTITY_KEY)
    expect(operations[0]!.expiresAtBlocks).toBe(500)

    expect(operations[1]!.newOwner).toBe(NEW_OWNER)
    expect(operations[1]!.entityKey).toBe(OTHER_KEY)

    expect(operations[2]!.entityKey).toBe(ENTITY_KEY)
    expect(operations[2]!.payload.size).toBe(0)
    expect(operations[2]!.attributes).toEqual([])
  })

  test("falls back to the absolute deadline when no lifetime was asked for", () => {
    const data = encodeExecute([createOp({ expiresAt: 1_200_000n })])
    const op = decodeCalldata(data).operations[0]!
    expect(op.expiresAt).toBe(1_200_000)
    expect(op.minLifetime).toBe(0)
    expect(op.expiresAtBlocks).toBe(1_200_000)
    // Nothing to convert: an absolute deadline is not a duration.
    expect(op.approxExpiresInSeconds).toBe(0)
  })

  test("clamps a never-expiring entity to a block count a consumer can store", () => {
    const data = encodeExecute([createOp({ expiresAt: 2n ** 64n - 1n })])
    const op = decodeCalldata(data).operations[0]!
    expect(op.expiresAtBlocks).toBe(Number.MAX_SAFE_INTEGER)
    expect(Number.isSafeInteger(op.expiresAtBlocks)).toBe(true)
  })

  test("labels unknown operation tags instead of misreporting them", () => {
    const { operations } = decodeCalldata(encodeExecute([unknownOp(99), deleteOp(ENTITY_KEY)]))
    expect(operations[0]!.operation).toBe("unknown(99)")
    expect(operations[0]!.operationType).toBe(99)
    // The rest of the batch still decodes around it.
    expect(operations[1]!.operation).toBe("delete")
  })

  test("rejects operation data that does not match its tag", () => {
    const data = encodeExecute([{ operation: EntityOperationType.Delete, operationData: "0x1234" }])
    expect(() => decodeCalldata(data)).toThrow(DecodeError)
  })

  test("rejects calldata for a different function", () => {
    expect(() => decodeCalldata("0xa9059cbb")).toThrow(DecodeError)
  })
})

describe("decodeCalldata (legacy struct format)", () => {
  test("decodes a create operation with payload, content type and attributes", () => {
    const data = encodeLegacyExecute([
      legacyCreateOp({
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
    expect(result.format).toBe("legacy")
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
    const update = legacyCreateOp({
      entityKey: ENTITY_KEY,
      payload: '{"a":1}',
      contentType: "application/json",
      expiresAtBlocks: 0,
    })
    update.operationType = EntityOperationType.Update

    const extend = legacyEmptyOp(EntityOperationType.Extend, OTHER_KEY)
    extend.expiresAt = 500

    const transfer = legacyEmptyOp(EntityOperationType.Transfer, OTHER_KEY)
    transfer.newOwner = NEW_OWNER

    const data = encodeLegacyExecute([
      update,
      legacyEmptyOp(EntityOperationType.Delete, ENTITY_KEY),
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
    const data = encodeLegacyExecute([
      legacyCreateOp({
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
    const op = legacyCreateOp({
      entityKey: ENTITY_KEY,
      payload: "x",
      contentType: "text/plain",
      expiresAtBlocks: 1,
    })
    op.attributes = [legacyAttribute({ key: "big", value: big })]

    const decoded = decodeCalldata(encodeLegacyExecute([op])).operations[0]!
    expect(decoded.attributes[0]!.value).toBe(big.toString())
  })

  test("labels unknown operation types instead of misreporting them", () => {
    const op = legacyEmptyOp(99, ENTITY_KEY)
    const decoded = decodeCalldata(encodeLegacyExecute([op])).operations[0]!
    expect(decoded.operation).toBe("unknown(99)")
  })
})

describe("recorded chain calldata", () => {
  test("decodes a create captured from the cheesecake devnet", async () => {
    const data = (await Bun.file(`${import.meta.dir}/../sample-execute-calldata.txt`).text()).trim()
    expect(data.startsWith(EXECUTE_SELECTOR)).toBe(true)

    const result = decodeArkivTransaction(data)
    expect(result.format).toBe("tagged")
    expect(result.operations).toHaveLength(1)

    const op = result.operations[0]!
    expect(op.operation).toBe("create")
    expect(op.payload.size).toBe(51_200)
    expect(op.payload.hex).toBeUndefined()
    expect(op.payload.text).toBeUndefined()
    expect(op.contentType).toBe("application/octet-stream")
    expect(op.expiresAtBlocks).toBe(900)
    expect(op.entityKey).toBeNull()

    expect(op.attributes.map((attr) => attr.key)).toEqual([
      "project",
      "random_number_0_58a5e94a261ca47d",
      "random_string_0_58a5e94a261ca47d",
    ])
    expect(op.attributes[0]).toEqual({
      key: "project",
      valueType: 8,
      valueTypeName: "str",
      value: "arkiv-chain-indexer-baseload",
    })
    expect(op.attributes[1]!.valueTypeName).toBe("u64")
    expect(op.attributes[1]!.value).toMatch(/^\d+$/)
  })
})

describe("decodeArkivTransaction", () => {
  test("accepts bare calldata", () => {
    const data = encodeExecute([deleteOp(ENTITY_KEY)])
    expect(data.startsWith(EXECUTE_SELECTOR)).toBe(true)
    const result = decodeArkivTransaction(data)
    expect(result.operations[0]!.operation).toBe("delete")
    expect(result.to).toBeUndefined()
  })

  test("accepts bare legacy calldata", () => {
    const data = encodeLegacyExecute([legacyEmptyOp(EntityOperationType.Delete, ENTITY_KEY)])
    expect(data.startsWith(LEGACY_EXECUTE_SELECTOR)).toBe(true)
    const result = decodeArkivTransaction(data)
    expect(result.format).toBe("legacy")
    expect(result.operations[0]!.operation).toBe("delete")
  })

  test("accepts a serialized EIP-1559 transaction and reports the target", () => {
    const data = encodeExecute([deleteOp(ENTITY_KEY)])
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
    const data = encodeExecute([deleteOp(ENTITY_KEY)])
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
