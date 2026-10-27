import { describe, expect, test } from "bun:test"
import { type Hex, keccak256, serializeTransaction, toBytes, toHex } from "viem"
import {
  ARKIV_ADDRESS,
  AttributeTypeId,
  DecodeError,
  EXECUTE_SELECTOR,
  INDEXED_FLAG,
  MAX_BYTES_LENGTH,
  OperationType,
  PERMANENT_EXPIRES_AT,
  decodeArkivTransaction,
  decodeCalldata,
} from "../src/decoder"
import {
  bytesCell,
  cell,
  createOp,
  deleteOp,
  encodeExecute,
  extendOp,
  patchOp,
  sorted,
  strCell,
  tombstoneCell,
  transferOp,
  unknownOp,
  wordCell,
} from "./encode"

const ENTITY_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111" as const
const OTHER_KEY = "0x2222222222222222222222222222222222222222222222222222222222222222" as const
const NEW_OWNER = "0xAbcd000000000000000000000000000000001234" as const

const OPERATION_KEYS = [
  "operationType",
  "operation",
  "entityKey",
  "salt",
  "creationFlags",
  "expiresAt",
  "minLifetime",
  "permanent",
  "newOwner",
  "bytesSize",
  "attributes",
]

function decodeOne(op: ReturnType<typeof createOp>) {
  return decodeCalldata(encodeExecute([op])).operations[0]!
}

function attributesOf(op: ReturnType<typeof createOp>) {
  return decodeOne(op).attributes
}

describe("create", () => {
  test("decodes every field, attributes in calldata order", () => {
    const body = '{"hello":"world"}'
    const result = decodeCalldata(
      encodeExecute([
        createOp({
          salt: 42n,
          minLifetime: 900n,
          creationFlags: 1,
          attributes: [
            bytesCell("body", body),
            strCell("category", "greeting"),
            wordCell("version", AttributeTypeId.U64, 42n, false),
          ],
        }),
      ]),
    )
    expect(result.functionName).toBe("execute")
    expect(result.format).toBe("udc")
    expect(result.operations).toHaveLength(1)

    const op = result.operations[0]!
    expect(Object.keys(op)).toEqual(OPERATION_KEYS)
    expect(op).toEqual({
      operationType: 1,
      operation: "create",
      // The engine derives a create's key from owner, nonce and salt, so calldata cannot name it.
      entityKey: null,
      salt: "42",
      creationFlags: 1,
      expiresAt: "0",
      minLifetime: "900",
      permanent: false,
      newOwner: null,
      bytesSize: 17,
      attributes: [
        {
          name: "body",
          typeId: 7,
          type: "bytes",
          indexed: false,
          value: null,
          size: 17,
          keccak256: keccak256(toBytes(body)),
        },
        { name: "category", typeId: 0x88, type: "str", indexed: true, value: "greeting", size: 8 },
        { name: "version", typeId: 3, type: "u64", indexed: false, value: "0x2a", size: 32 },
      ],
    })
  })

  test("reports a permanent entity's expiry exactly", () => {
    const op = decodeOne(createOp({ expiresAt: PERMANENT_EXPIRES_AT }))
    expect(op.expiresAt).toBe("18446744073709551615")
    expect(op.minLifetime).toBe("0")
    expect(op.permanent).toBe(true)
  })

  test("keeps a uint128 salt and uint64 expiry pair exact", () => {
    const op = decodeOne(createOp({ salt: 2n ** 128n - 1n, expiresAt: 2n ** 63n + 1n, minLifetime: 2n ** 64n - 2n }))
    expect(op.salt).toBe((2n ** 128n - 1n).toString())
    expect(op.expiresAt).toBe((2n ** 63n + 1n).toString())
    expect(op.minLifetime).toBe((2n ** 64n - 2n).toString())
    expect(op.permanent).toBe(false)
  })

  test("sums the bytes of every bytes attribute, and only those", () => {
    const op = decodeOne(
      createOp({
        attributes: [
          bytesCell("a", new Uint8Array(10)),
          bytesCell("b", new Uint8Array(0)),
          bytesCell("c", new Uint8Array(300)),
          strCell("d", "not counted"),
        ],
      }),
    )
    expect(op.bytesSize).toBe(310)
    expect(op.attributes.map((a) => a.size)).toEqual([10, 0, 300, 11])
  })
})

describe("attribute values", () => {
  test("follow the low seven bits of typeId, with bit 7 as the indexed flag", () => {
    const values: [AttributeTypeId, string, bigint][] = [
      [AttributeTypeId.Bool, "bool", 1n],
      [AttributeTypeId.I32, "i32", -7n],
      [AttributeTypeId.U64, "u64", 7n],
      [AttributeTypeId.U256, "u256", 7n],
      [AttributeTypeId.Dec, "dec", 7_000_000_000_000_000_000n],
      [AttributeTypeId.Bytes32, "bytes32", 7n],
      [AttributeTypeId.Addr, "addr", 7n],
      [AttributeTypeId.Key, "key", 7n],
    ]
    for (const indexed of [true, false]) {
      const attributes = attributesOf(
        createOp({ attributes: values.map(([typeId, , v], i) => wordCell(`a${i}`, typeId, v, indexed)) }),
      )
      expect(attributes.map((a) => [a.type as string, a.indexed, a.typeId])).toEqual(
        values.map(([typeId, type]) => [type, indexed, typeId | (indexed ? INDEXED_FLAG : 0)]),
      )
      expect(attributes.map((a) => a.value)).toEqual([
        true,
        -7,
        "0x7",
        "0x7",
        "7",
        `0x${"00".repeat(31)}07`,
        `0x${"00".repeat(19)}07`,
        `0x${"00".repeat(31)}07`,
      ])
      expect(attributes.every((a) => a.error === undefined)).toBe(true)
    }
  })

  test("use the encoding arkiv_query returns, whatever the magnitude", () => {
    const attributes = attributesOf(
      createOp({
        attributes: sorted([
          wordCell("f", AttributeTypeId.Bool, 0n),
          wordCell("t", AttributeTypeId.Bool, 1n),
          wordCell("i32min", AttributeTypeId.I32, -(2n ** 31n)),
          wordCell("i32max", AttributeTypeId.I32, 2n ** 31n - 1n),
          wordCell("u64zero", AttributeTypeId.U64, 0n),
          wordCell("u64max", AttributeTypeId.U64, 2n ** 64n - 1n),
          wordCell("u256max", AttributeTypeId.U256, 2n ** 256n - 1n),
          wordCell("decimal", AttributeTypeId.Dec, 3_500_000_000_000_000_000n),
          wordCell("decneg", AttributeTypeId.Dec, -250_000_000_000_000_000n),
          wordCell("dectiny", AttributeTypeId.Dec, 1n),
          wordCell("deczero", AttributeTypeId.Dec, 0n),
          wordCell("decmin", AttributeTypeId.Dec, -(2n ** 255n)),
          wordCell("digest", AttributeTypeId.Bytes32, BigInt("0xABCDEF" + "00".repeat(29))),
          wordCell("owner", AttributeTypeId.Addr, BigInt(NEW_OWNER)),
          wordCell("parent", AttributeTypeId.Key, BigInt(ENTITY_KEY)),
          strCell("name", "Zażółć gęślą jaźń 🙂"),
          strCell("empty", ""),
        ]),
      }),
    )
    expect(attributes.filter((a) => a.error !== undefined)).toEqual([])
    expect(Object.fromEntries(attributes.map((a) => [a.name, a.value]))).toEqual({
      f: false,
      t: true,
      i32min: -2147483648,
      i32max: 2147483647,
      u64zero: "0x0",
      u64max: "0xffffffffffffffff",
      u256max: `0x${"f".repeat(64)}`,
      decimal: "3.5",
      decneg: "-0.25",
      dectiny: "0.000000000000000001",
      deczero: "0",
      decmin: `-${(2n ** 255n / 10n ** 18n).toString()}.${(2n ** 255n % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "")}`,
      digest: `0xabcdef${"00".repeat(29)}`,
      // Lowercase, as the node returns addresses.
      owner: NEW_OWNER.toLowerCase(),
      parent: ENTITY_KEY,
      name: "Zażółć gęślą jaźń 🙂",
      empty: "",
    })
    expect(attributes.find((a) => a.name === "name")!.size).toBe(toBytes("Zażółć gęślą jaźń 🙂").length)
  })

  test("keep a byte order mark in a str as the node does", () => {
    const [attribute] = attributesOf(createOp({ attributes: [strCell("bom", "﻿text")] }))
    expect(attribute!.value).toBe("﻿text")
  })

  test("keep case-sensitive names apart", () => {
    const attributes = attributesOf(
      createOp({
        attributes: [wordCell("Level", AttributeTypeId.I32, 1n), wordCell("level", AttributeTypeId.I32, 2n)],
      }),
    )
    expect(attributes.map((a) => [a.name, a.value])).toEqual([
      ["Level", 1],
      ["level", 2],
    ])
  })

  test("report bytes as size and keccak256 alone", () => {
    const content = new Uint8Array(32 * 1024).fill(0x07)
    const op = decodeOne(createOp({ attributes: [bytesCell("cover", content)] }))
    expect(op.attributes[0]).toEqual({
      name: "cover",
      typeId: 7,
      type: "bytes",
      indexed: false,
      value: null,
      size: 32 * 1024,
      keccak256: keccak256(content),
    })
    expect(JSON.stringify(op)).not.toContain("0707")
  })
})

describe("malformed triples", () => {
  test("come back as invalid(0x..) with an error instead of failing the batch", () => {
    const op = decodeOne(
      createOp({
        attributes: [
          cell("a1indexedbytes", AttributeTypeId.Bytes | INDEXED_FLAG, toHex(toBytes("secret content"))),
          cell("a2flaggedtombstone", INDEXED_FLAG, "0x"),
          cell("a3unknown", 0x0b, toHex(1n, { size: 32 })),
          cell("a4unknownindexed", 0xff, toHex(1n, { size: 32 })),
          strCell("a5fine", "still decoded"),
        ],
      }),
    )
    expect(op.attributes.map((a) => [a.name, a.type, a.indexed, a.value])).toEqual([
      ["a1indexedbytes", "invalid(0x87)", true, null],
      ["a2flaggedtombstone", "invalid(0x80)", true, null],
      ["a3unknown", "invalid(0x0b)", false, null],
      ["a4unknownindexed", "invalid(0xff)", true, null],
      ["a5fine", "str", true, "still decoded"],
    ])
    expect(op.attributes.map((a) => a.error)).toEqual([
      "bytes are stored, never indexed: the indexed flag is not allowed on bytes",
      "a tombstone never carries the indexed flag",
      "the typeId names no attribute type",
      "the typeId names no attribute type",
      undefined,
    ])
    for (const attribute of op.attributes.slice(0, 4)) {
      expect(attribute.error).toBeString()
      expect(attribute.keccak256).toBeUndefined()
    }
    expect(op.attributes[4]!.error).toBeUndefined()
    // An indexed bytes cell is not counted as bytes, and its content is not shown.
    expect(op.bytesSize).toBe(0)
    expect(JSON.stringify(op)).not.toContain(toHex(toBytes("secret content")).slice(2))
    expect(JSON.stringify(op)).not.toContain("secret content")
  })

  test("refuse what the node's decode_abi_value refuses, value null", () => {
    const word = (n: bigint) => toHex(n, { size: 32 })
    const attributes = attributesOf(
      createOp({
        attributes: [
          cell("a00bool2", AttributeTypeId.Bool, word(2n)),
          cell("a01i32wide", AttributeTypeId.I32, word(2n ** 31n)),
          cell("a02u64wide", AttributeTypeId.U64, word(2n ** 64n)),
          cell("a03addrwide", AttributeTypeId.Addr, word(2n ** 160n)),
          cell("a04short", AttributeTypeId.U256, toHex(1n, { size: 31 })),
          cell("a05long", AttributeTypeId.Key, toHex(1n, { size: 33 })),
          cell("a06utf8", AttributeTypeId.Str, "0xff00"),
          cell("a07toolong", AttributeTypeId.Str, toHex(toBytes("x".repeat(129)))),
          cell("a08control", AttributeTypeId.Str, toHex(toBytes("tab\there"))),
          cell("a09del", AttributeTypeId.Str, toHex(toBytes("del\u007f"))),
          tombstoneCell("a10tombstone"),
        ],
      }),
    )
    expect(attributes.map((a) => [a.value, a.error])).toEqual([
      [null, "a bool word must hold exactly 0 or 1"],
      [null, "an i32 word must be sign-extended"],
      [null, "a u64 word must be zero-padded to 8 bytes"],
      [null, "an addr word must be zero-padded to 20 bytes"],
      [null, "a u256 value must be 32 bytes"],
      [null, "a key value must be 32 bytes"],
      [null, "a str value must be valid UTF-8"],
      [null, "a str value is longer than 128 bytes"],
      [null, "a str value must not contain control characters"],
      [null, "a str value must not contain control characters"],
      // A tombstone in a create is no mutation at all.
      [null, "a tombstone (typeId 0) is legal only in a patch"],
    ])
    expect(attributes.map((a) => a.type)).toEqual([
      "bool",
      "i32",
      "u64",
      "addr",
      "u256",
      "key",
      "str",
      "str",
      "str",
      "str",
      "tombstone",
    ])
    expect(attributes.map((a) => a.size)).toEqual([32, 32, 32, 32, 31, 33, 2, 129, 8, 4, 0])
  })

  test("an oversized bytes value is flagged and still never shown", () => {
    const content = new Uint8Array(MAX_BYTES_LENGTH + 1).fill(0x5a)
    const op = decodeOne(createOp({ attributes: [bytesCell("huge", content)] }))
    const attribute = op.attributes[0]!
    expect(attribute.type).toBe("bytes")
    expect(attribute.value).toBeNull()
    expect(attribute.size).toBe(MAX_BYTES_LENGTH + 1)
    expect(attribute.keccak256).toBe(keccak256(content))
    expect(attribute.error).toContain(`${MAX_BYTES_LENGTH}`)
    expect(JSON.stringify(op)).not.toContain("5a5a")
  })

  test("a name that is not NUL-padded UTF-8 is reported as its hex", () => {
    const notPadded = `0x61006200${"00".repeat(28)}` as Hex
    const notUtf8 = `0xff${"00".repeat(31)}` as Hex
    const op = decodeOne(
      createOp({
        attributes: [
          { name: notPadded, typeId: AttributeTypeId.Str | INDEXED_FLAG, value: toHex(toBytes("v")) },
          { name: notUtf8, typeId: AttributeTypeId.Str | INDEXED_FLAG, value: toHex(toBytes("v")) },
        ],
      }),
    )
    // The value still decodes: what is wrong is the name, and the error says so.
    expect(op.attributes.map((a) => [a.name, a.value, a.error])).toEqual([
      [notPadded, "v", "the name is not NUL-padded UTF-8"],
      [notUtf8, "v", "the name is not NUL-padded UTF-8"],
    ])
  })
})

describe("node policy", () => {
  // What the node's decode_protocol_triples and validate refuse, decided from calldata alone. The
  // node never mines such a transaction; the decoder says why rather than failing the batch.
  test("flags names the node refuses, keeping a value that decodes", () => {
    const names = ["", "$owner", "1abc", "STR", "a b", "a--b", "str"]
    const op = decodeOne(createOp({ attributes: sorted(names.map((n) => strCell(n, "x"))) }))
    expect(op.attributes.map((a) => [a.name, a.value, a.error])).toEqual([
      ["", "x", "the name is not a letter followed by letters, digits, '.', '-' or '_'"],
      ["$owner", "x", "the name is not a letter followed by letters, digits, '.', '-' or '_'"],
      ["1abc", "x", "the name is not a letter followed by letters, digits, '.', '-' or '_'"],
      ["STR", "x", "the name is a reserved word of the query language"],
      ["a b", "x", "the name is not a letter followed by letters, digits, '.', '-' or '_'"],
      ["a--b", "x", "the name contains '--', which opens a query comment"],
      ["str", "x", "the name is a reserved word of the query language"],
    ])
  })

  test("accepts every name the grammar allows, up to 32 bytes", () => {
    const names = ["A", "a.b", "a-b", "a_b", "a9", "n".repeat(32)]
    const op = decodeOne(createOp({ attributes: sorted(names.map((n) => strCell(n, "x"))) }))
    expect(op.attributes.every((a) => a.error === undefined)).toBe(true)
  })

  test("flags names out of ascending byte order, and duplicates", () => {
    const op = decodeOne(
      createOp({ attributes: [strCell("b", "1"), strCell("a", "2"), strCell("c", "3"), strCell("c", "4")] }),
    )
    expect(op.attributes.map((a) => [a.name, a.value, a.error])).toEqual([
      ["b", "1", undefined],
      ["a", "2", "names must be unique and in ascending byte order"],
      ["c", "3", undefined],
      ["c", "4", "names must be unique and in ascending byte order"],
    ])
  })

  test("an order error outranks a value error, as the node checks order first", () => {
    const op = decodeOne(createOp({ attributes: [strCell("b", "1"), cell("a", AttributeTypeId.Bool, toHex(2n, { size: 32 }))] }))
    expect(op.attributes[1]!.error).toBe("names must be unique and in ascending byte order")
  })

  test("flags creation flags beyond readonly and permissionless extension", () => {
    expect(decodeOne(createOp({ creationFlags: 3 })).error).toBeUndefined()
    const op = decodeOne(createOp({ creationFlags: 0xff }))
    expect(op.creationFlags).toBe(0xff)
    expect(op.error).toBe("creationFlags sets bits other than readonly (1) and permissionless extension (2)")
  })

  test("flags an operation whose bytes values hold more than an entity may", () => {
    const op = decodeOne(
      createOp({ attributes: [bytesCell("a", new Uint8Array(70 * 1024)), bytesCell("b", new Uint8Array(70 * 1024))] }),
    )
    expect(op.bytesSize).toBe(140 * 1024)
    expect(op.attributes.every((a) => a.error === undefined)).toBe(true)
    expect(op.error).toBe("the bytes values together hold more than the 131072 bytes an entity may")
    const patch = decodeOne(
      patchOp({ entityKey: ENTITY_KEY, mutations: [bytesCell("a", new Uint8Array(129 * 1024))] }),
    )
    expect(patch.error).toBeString()
  })

  test("a well-formed operation has no error key at all", () => {
    const op = decodeOne(createOp({ minLifetime: 1n, attributes: [strCell("a", "x")] }))
    expect("error" in op).toBe(false)
    expect("error" in op.attributes[0]!).toBe(false)
  })

  test("flags a tombstone whose name the node refuses", () => {
    const op = decodeOne(patchOp({ entityKey: ENTITY_KEY, mutations: [tombstoneCell("exists")] }))
    expect(op.attributes[0]).toMatchObject({ type: "tombstone", error: "the name is a reserved word of the query language" })
  })
})

describe("patch", () => {
  test("lists its mutations: sets with their new type and flag, tombstones that unset", () => {
    const op = decodeOne(
      patchOp({
        entityKey: ENTITY_KEY,
        mutations: [
          bytesCell("body", '{"a":1}'),
          tombstoneCell("drop"),
          wordCell("level", AttributeTypeId.I32, 2n),
          strCell("level2", "now stored", false),
        ],
      }),
    )
    expect(op).toEqual({
      operationType: OperationType.Patch,
      operation: "patch",
      entityKey: ENTITY_KEY,
      salt: null,
      creationFlags: null,
      expiresAt: null,
      minLifetime: null,
      permanent: null,
      newOwner: null,
      bytesSize: 7,
      attributes: [
        {
          name: "body",
          typeId: 7,
          type: "bytes",
          indexed: false,
          value: null,
          size: 7,
          keccak256: keccak256(toBytes('{"a":1}')),
        },
        { name: "drop", typeId: 0, type: "tombstone", indexed: false, value: null, size: 0 },
        { name: "level", typeId: 0x82, type: "i32", indexed: true, value: 2, size: 32 },
        { name: "level2", typeId: 8, type: "str", indexed: false, value: "now stored", size: 10 },
      ],
    })
  })

  test("flags a tombstone that carries a value", () => {
    const op = decodeOne(patchOp({ entityKey: ENTITY_KEY, mutations: [cell("drop", 0, "0x01")] }))
    expect(op.attributes[0]).toMatchObject({ type: "tombstone", value: null, size: 1 })
    expect(op.attributes[0]!.error).toBeString()
  })

  test("an empty patch has no attributes", () => {
    const op = decodeOne(patchOp({ entityKey: ENTITY_KEY }))
    expect(op.attributes).toEqual([])
    expect(op.bytesSize).toBe(0)
  })
})

describe("extend, transfer and delete", () => {
  test("decode in a batch, in order", () => {
    const { operations } = decodeCalldata(
      encodeExecute([
        extendOp({ entityKey: ENTITY_KEY, minLifetime: 500n }),
        extendOp({ entityKey: OTHER_KEY, expiresAt: PERMANENT_EXPIRES_AT }),
        transferOp({ entityKey: OTHER_KEY, newOwner: NEW_OWNER }),
        deleteOp(ENTITY_KEY),
      ]),
    )
    const empty = {
      salt: null,
      creationFlags: null,
      expiresAt: null,
      minLifetime: null,
      permanent: null,
      newOwner: null,
      bytesSize: 0,
      attributes: [],
    }
    expect(operations).toEqual([
      {
        ...empty,
        operationType: 3,
        operation: "extend",
        entityKey: ENTITY_KEY,
        expiresAt: "0",
        minLifetime: "500",
        permanent: false,
      },
      {
        ...empty,
        operationType: 3,
        operation: "extend",
        entityKey: OTHER_KEY,
        expiresAt: "18446744073709551615",
        minLifetime: "0",
        permanent: true,
      },
      // The new owner is lowercase, as the node's owner field is.
      { ...empty, operationType: 4, operation: "transfer", entityKey: OTHER_KEY, newOwner: NEW_OWNER.toLowerCase() as Hex },
      { ...empty, operationType: 5, operation: "delete", entityKey: ENTITY_KEY },
    ])
    for (const op of operations) expect(Object.keys(op)).toEqual(OPERATION_KEYS)
  })

  test("entity keys come back lowercase", () => {
    const upper = "0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD" as Hex
    const op = decodeOne(deleteOp(upper))
    expect(op.entityKey).toBe(upper.toLowerCase() as Hex)
  })
})

describe("decodeCalldata", () => {
  test("refuses an operation tag the node does not accept", () => {
    // The node answers UnsupportedArkivOperation for the whole transaction, so it never mines one.
    expect(() => decodeCalldata(encodeExecute([unknownOp(99), deleteOp(ENTITY_KEY)]))).toThrow(DecodeError)
    expect(() => decodeCalldata(encodeExecute([unknownOp(0)]))).toThrow(DecodeError)
  })

  test("rejects operation data that does not match its tag", () => {
    const data = encodeExecute([{ operation: OperationType.Delete, operationData: "0x1234" }])
    expect(() => decodeCalldata(data)).toThrow(DecodeError)
  })

  test("rejects calldata for a different function", () => {
    expect(() => decodeCalldata("0xa9059cbb")).toThrow(DecodeError)
  })

  test("rejects the pre-UDC struct format", () => {
    // 0xba8ccf92 is execute((uint8,bytes32,bytes,(bytes32[4]),(bytes32,uint8,bytes32[4])[],uint32,address)[]).
    expect(() => decodeCalldata(`0xba8ccf92${"00".repeat(64)}`)).toThrow(DecodeError)
    expect(() => decodeArkivTransaction(`0xba8ccf92${"00".repeat(64)}`)).toThrow(DecodeError)
  })

  test("rejects a truncated execute() call", () => {
    const data = encodeExecute([deleteOp(ENTITY_KEY)])
    expect(() => decodeCalldata(data.slice(0, 80) as Hex)).toThrow(DecodeError)
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

  test("accepts a serialized EIP-1559 transaction and reports the target", () => {
    const data = encodeExecute([deleteOp(ENTITY_KEY)])
    const serialized = serializeTransaction({
      type: "eip1559",
      chainId: 7706815,
      to: ARKIV_ADDRESS,
      nonce: 7,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 0n,
      gas: 100_000n,
      data,
    })

    const result = decodeArkivTransaction(serialized)
    expect(result.to).toBe(ARKIV_ADDRESS)
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
    expect(result.to).toBe(NEW_OWNER.toLowerCase() as Hex)
    expect(result.warning).toContain(NEW_OWNER.toLowerCase())
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
