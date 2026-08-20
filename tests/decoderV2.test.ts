import { describe, expect, test } from "bun:test"
import { serializeTransaction, toHex } from "viem"
import { ArkivOperationTag, EXECUTE_V2_SELECTOR } from "../src/abi"
import {
  ARKIV_ADDRESS,
  DecodeError,
  type DecodedTransaction,
  type DecodedTransactionV2,
  type DecodedViewCall,
  UnknownSelectorError,
  decodeArkivTransaction,
  decodeCalldataV2,
  resolveExpiry,
} from "../src/decoder"
import { attr, createOpV2, deleteOpV2, encodeExecuteV2, extendOpV2, patchOpV2, transferOpV2, word } from "./encodeV2"
import { emptyOp, encodeExecute } from "./encode"
import { EntityOperationType } from "../src/decoder"

const ENTITY_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111" as const
const OTHER_KEY = "0x2222222222222222222222222222222222222222222222222222222222222222" as const
const NEW_OWNER = "0xAbcd000000000000000000000000000000001234" as const

function decodeOne(calldata: `0x${string}`, options?: Parameters<typeof decodeCalldataV2>[1]) {
  const result = decodeCalldataV2(calldata, options)
  expect(result.operations).toHaveLength(1)
  return result.operations[0]!
}

describe("decodeCalldataV2 operations", () => {
  test("decodes a create, lifting $payload and $contentType out of the attributes", () => {
    const op = decodeOne(
      encodeExecuteV2([
        createOpV2({
          salt: 337797463300736330483541628654607568406n,
          minLifetime: 30n,
          creationFlags: 1,
          attributes: [
            attr.str("$contentType", "application/json"),
            attr.bytes("$payload", new TextEncoder().encode('{"probe":"smoke"}')),
            attr.str("kind", "smoke"),
            attr.i32("rank", 2),
          ],
        }),
      ]),
    )

    expect(op.operation).toBe("create")
    expect(op.operationType).toBe(ArkivOperationTag.Create)
    expect(op.index).toBe(0)
    // A create carries a salt: the key is derived on chain, so we must not invent one.
    expect(op.entityKey).toBeNull()
    expect(op.salt).toBe("337797463300736330483541628654607568406")
    expect(op.creationFlags).toBe(1)
    expect(op.creationFlagNames).toEqual(["readonly"])
    expect(op.contentType).toBe("application/json")
    expect(op.payload.size).toBe(17)
    expect(op.payload.present).toBe(true)
    expect(op.payload.text).toBe('{"probe":"smoke"}')
    expect(op.systemAttributes).toEqual(["$contentType", "$payload"])
    expect(op.attributeCount).toBe(4)
    expect(op.attributes).toEqual([
      { key: "kind", valueType: 8, valueTypeName: "str", value: "smoke", sizeBytes: 5 },
      { key: "rank", valueType: 2, valueTypeName: "i32", value: "2", sizeBytes: 32 },
    ])
  })

  test("decodes a patch, including a tombstone mutation", () => {
    const op = decodeOne(
      encodeExecuteV2([
        patchOpV2(ENTITY_KEY, [attr.tombstone("flag"), attr.i32("rank", 2), attr.str("status", "patched")]),
      ]),
    )

    expect(op.operation).toBe("patch")
    expect(op.entityKey).toBe(ENTITY_KEY)
    expect(op.attributeCount).toBe(3)
    expect(op.attributes[0]).toEqual({ key: "flag", valueType: 0, valueTypeName: "tombstone", value: "", sizeBytes: 0 })
    expect(op.payload.present).toBe(false)
    expect(op.payload.size).toBe(0)
  })

  test("decodes an extend_expiry and resolves the block only when given one", () => {
    const calldata = encodeExecuteV2([extendOpV2(ENTITY_KEY, 0n, 150n)])

    const bare = decodeOne(calldata)
    expect(bare.operation).toBe("extend_expiry")
    expect(bare.expiresAt).toBe("0")
    expect(bare.minLifetime).toBe("150")
    expect(bare.resolvedExpiresAt).toBeNull()

    const withBlock = decodeOne(calldata, { blockNumber: 222495n })
    expect(withBlock.resolvedExpiresAt).toBe("222645")
    expect(withBlock.expiresAtBlocks).toBe("222645")
  })

  test("a permanent entity keeps its exact expiry instead of rounding to a wrong number", () => {
    // arkiv-reth-executor decode.rs:167 expresses permanence as expiresAt = u64::MAX. It is
    // a normal successful value, and Number() renders it 18446744073709552000: wrong by 385
    // and past the int8 ceiling of the indexer's expires_at_blocks column.
    const u64Max = 2n ** 64n - 1n
    const op = decodeOne(encodeExecuteV2([createOpV2({ expiresAt: u64Max })]), { blockNumber: 222_498n })
    for (const field of [op.expiresAt, op.resolvedExpiresAt, op.expiresAtBlocks]) {
      expect(field).toBe("18446744073709551615")
      expect(field).not.toBe(String(Number(u64Max)))
    }
    expect(op.minLifetime).toBe("0")
  })

  test("decodes a transfer_ownership and checksums the new owner", () => {
    const op = decodeOne(encodeExecuteV2([transferOpV2(OTHER_KEY, NEW_OWNER)]))
    expect(op.operation).toBe("transfer_ownership")
    expect(op.entityKey).toBe(OTHER_KEY)
    expect(op.newOwner).toBe(NEW_OWNER)
  })

  test("decodes a delete", () => {
    const op = decodeOne(encodeExecuteV2([deleteOpV2(ENTITY_KEY)]))
    expect(op.operation).toBe("delete")
    expect(op.entityKey).toBe(ENTITY_KEY)
    expect(op.attributes).toEqual([])
  })

  test("keeps the count and order of a mixed batch", () => {
    const result = decodeCalldataV2(
      encodeExecuteV2([
        createOpV2({ minLifetime: 30n }),
        patchOpV2(ENTITY_KEY, [attr.str("batched", "yes")]),
        deleteOpV2(OTHER_KEY),
      ]),
    )
    expect(result.operationCount).toBe(3)
    expect(result.operations.map((op) => op.operation)).toEqual(["create", "patch", "delete"])
    expect(result.operations.map((op) => op.index)).toEqual([0, 1, 2])
  })
})

describe("attribute values", () => {
  function attributeFor(a: ReturnType<typeof attr.str>) {
    return decodeOne(encodeExecuteV2([patchOpV2(ENTITY_KEY, [a])])).attributes[0]!
  }

  test("renders every known value type", () => {
    expect(attributeFor(attr.bool("b", true)).value).toBe("true")
    expect(attributeFor(attr.bool("b", false)).value).toBe("false")
    expect(attributeFor(attr.i32("i", 10)).value).toBe("10")
    expect(attributeFor(attr.i32("i", -1)).value).toBe("-1")
    expect(attributeFor(attr.i32("i", -2147483648)).value).toBe("-2147483648")
    expect(attributeFor(attr.u64("u", 2n ** 64n - 1n)).value).toBe("18446744073709551615")
    expect(attributeFor(attr.u256("u", 2n ** 256n - 1n)).value).toBe(
      "115792089237316195423570985008687907853269984665640564039457584007913129639935",
    )
    expect(attributeFor(attr.dec("d", 1_500_000_000_000_000_000n)).value).toBe("1.5")
    expect(attributeFor(attr.dec("d", -250_000_000_000_000_000n)).value).toBe("-0.25")
    expect(attributeFor(attr.dec("d", 1_000_000_000_000_000_000n)).value).toBe("1")
    expect(attributeFor(attr.bytes32("h", ENTITY_KEY)).value).toBe(ENTITY_KEY)
    expect(attributeFor(attr.key("k", OTHER_KEY)).value).toBe(OTHER_KEY)
    expect(attributeFor(attr.addr("a", NEW_OWNER)).value).toBe(NEW_OWNER)
    expect(attributeFor(attr.str("s", "hello")).value).toBe("hello")
    expect(attributeFor(attr.bytes("z", new Uint8Array([0xff, 0x00]))).value).toBe("0xff00")
  })

  test("names value types by the generation-2 vocabulary, not the legacy one", () => {
    // Legacy type 2 is String, generation-2 type 2 is i32. Reusing the old names here
    // would silently record wrong types downstream.
    expect(attributeFor(attr.i32("i", 1)).valueTypeName).toBe("i32")
    expect(attributeFor(attr.str("s", "x")).valueTypeName).toBe("str")
  })

  test("rejects a non-canonical i32 sign extension", () => {
    // 0xFF fill with a positive low word: the chain would refuse this.
    const bad = { name: toHex("i", { size: 32 }), typeId: 2, value: `0x${"ff".repeat(28)}00000001` as const }
    const decoded = attributeFor(bad)
    expect(decoded.valueTypeName).toBe("invalid")
    expect(decoded.error).toContain("sign extension")
    expect(decoded.value).toBe(bad.value)
  })

  test("rejects a word type whose value is not 32 bytes", () => {
    const bad = { name: toHex("u", { size: 32 }), typeId: 3, value: "0x01" as const }
    const decoded = attributeFor(bad)
    expect(decoded.valueTypeName).toBe("invalid")
    expect(decoded.error).toContain("32 bytes")
  })

  test("rejects non-zero padding on a u64", () => {
    const bad = { name: toHex("u", { size: 32 }), typeId: 3, value: `0x01${"00".repeat(31)}` as const }
    expect(attributeFor(bad).valueTypeName).toBe("invalid")
  })

  test("rejects a tombstone that carries a value", () => {
    const bad = { name: toHex("t", { size: 32 }), typeId: 0, value: "0x01" as const }
    expect(attributeFor(bad).valueTypeName).toBe("invalid")
  })

  test("records an unfamiliar type id instead of failing the whole decode", () => {
    // The type set is an open enum. Halting an indexer on one unknown value is worse
    // than recording it, so this stays soft while struct-level failures stay loud.
    const alien = { name: toHex("x", { size: 32 }), typeId: 77, value: word(5n) }
    const decoded = attributeFor(alien)
    expect(decoded.valueTypeName).toBe("unknown")
    expect(decoded.value).toBe(word(5n))
    expect(decoded.valueType).toBe(77)
  })

  test("omits the payload hex above the limit but keeps the size", () => {
    const big = new Uint8Array(9000).fill(0x41)
    const op = decodeOne(encodeExecuteV2([createOpV2({ attributes: [attr.bytes("$payload", big)] })]))
    expect(op.payload.size).toBe(9000)
    expect(op.payload.truncated).toBe(true)
    expect(op.payload.hex).toBeUndefined()
    expect(decodeOne(encodeExecuteV2([createOpV2({ attributes: [attr.bytes("$payload", big)] })]), {
      payloadHexLimit: 16_384,
    }).payload.hex).toBeDefined()
  })

  test("warns when $payload is a tombstone rather than reporting a payload", () => {
    const result = decodeCalldataV2(encodeExecuteV2([patchOpV2(ENTITY_KEY, [attr.tombstone("$payload")])]))
    expect(result.operations[0]!.payload).toEqual({ size: 0, present: true })
    expect(result.warnings?.join(" ")).toContain("$payload is a tombstone")
  })
})

describe("undecodable calldata is recorded, never thrown", () => {
  // Anyone can send these bytes to the registry. The node reverts the transaction, but it
  // stays in the block and the indexer must still get past it, so none of them may throw.
  test("an unknown operation tag becomes a row, keeping the raw tag", () => {
    const result = decodeCalldataV2(encodeExecuteV2([{ operation: 9, operationData: "0x" }]))
    const op = result.operations[0]!
    expect(op.undecodable?.code).toBe("UNKNOWN_OPERATION_TAG")
    expect(op.operationType).toBe(9)
    expect(op.operation).toBe("unknown(9)")
    expect(op.payload.size).toBe(0)
    expect(op.attributes).toEqual([])
  })

  test("operationData that does not match the struct becomes a row", () => {
    const calldata = encodeExecuteV2([{ operation: ArkivOperationTag.Delete, operationData: "0x1234" }])
    const op = decodeCalldataV2(calldata).operations[0]!
    expect(op.undecodable?.code).toBe("MALFORMED_OPERATION_DATA")
    // The tag claims delete, but a struct we could not parse is not proof a delete happened.
    expect(op.operation).toBe("unknown(5)")
    expect(op.operationType).toBe(ArkivOperationTag.Delete)
  })

  test("one bad operation does not cost the batch its good ones", () => {
    const result = decodeCalldataV2(
      encodeExecuteV2([deleteOpV2(ENTITY_KEY), { operation: 6, operationData: "0x" }, deleteOpV2(OTHER_KEY)]),
    )
    expect(result.operations.map((op) => op.operation)).toEqual(["delete", "unknown(6)", "delete"])
    expect(result.operations.map((op) => op.undecodable?.code)).toEqual([
      undefined,
      "UNKNOWN_OPERATION_TAG",
      undefined,
    ])
    expect(result.operations[2]!.entityKey).toBe(OTHER_KEY)
  })

  test("a correct selector with a broken argument block is an empty batch, not a throw", () => {
    const result = decodeCalldataV2(`${EXECUTE_V2_SELECTOR}deadbeef`)
    expect(result.undecodable?.code).toBe("MALFORMED_CALLDATA")
    expect(result.operationCount).toBe(0)
    expect(result.operations).toEqual([])
    expect(result.selector).toBe(EXECUTE_V2_SELECTOR)
  })

  test("a non-canonical encoding is reported as a warning, not a failure", () => {
    // Same delete, but with 32 bytes of trailing junk the canonical encoder would not emit.
    const canonical = deleteOpV2(ENTITY_KEY)
    const padded = { operation: canonical.operation, operationData: `${canonical.operationData}${"00".repeat(32)}` as const }
    const result = decodeCalldataV2(encodeExecuteV2([padded]))
    expect(result.operations[0]!.entityKey).toBe(ENTITY_KEY)
    expect(result.warnings?.join(" ")).toContain("not canonically encoded")
  })
})

describe("selector dispatch", () => {
  test("routes generation-2 calldata to the new decoder", () => {
    const result = decodeArkivTransaction(encodeExecuteV2([deleteOpV2(ENTITY_KEY)])) as DecodedTransactionV2
    expect(result.abi).toBe("v2")
    expect(result.selector).toBe(EXECUTE_V2_SELECTOR)
    expect(result.operations[0]!.operation).toBe("delete")
  })

  test("still routes legacy calldata to the legacy decoder", () => {
    const result = decodeArkivTransaction(
      encodeExecute([emptyOp(EntityOperationType.Delete, ENTITY_KEY)]),
    ) as DecodedTransaction
    expect(result.operations[0]!.operation).toBe("delete")
    expect(result.abi).toBe("legacy")
  })

  test("accepts a serialized transaction carrying generation-2 calldata", () => {
    const serialized = serializeTransaction({
      type: "eip1559",
      chainId: 7733102,
      to: ARKIV_ADDRESS,
      nonce: 1,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
      gas: 200_000n,
      data: encodeExecuteV2([deleteOpV2(ENTITY_KEY)]),
    })
    const result = decodeArkivTransaction(serialized)
    expect(result.to?.toLowerCase()).toBe(ARKIV_ADDRESS.toLowerCase())
    expect(result.warning).toBeUndefined()
    expect(result.operations[0]!.operation).toBe("delete")
  })

  test("reports a registry read-only call as a call with no operations", () => {
    const result = decodeArkivTransaction(`0x36917bfd${"00".repeat(32)}`) as DecodedViewCall
    expect(result.functionName).toBe("entityNonce")
    expect(result.operations).toEqual([])
    expect(result.operationCount).toBe(0)
  })

  test("an unknown selector on unknown calldata stays a skippable 400-class error", () => {
    const error = (() => {
      try {
        decodeArkivTransaction(`0xdeadbeef${"00".repeat(32)}`)
      } catch (e) {
        return e as UnknownSelectorError
      }
    })()
    expect(error).toBeInstanceOf(UnknownSelectorError)
    expect(error!.targetIsRegistry).toBe(false)
    expect(error!.selector).toBe("0xdeadbeef")
  })

  test("an unknown selector aimed at the registry is flagged as a decoder gap", () => {
    const error = (() => {
      try {
        decodeArkivTransaction(`0xdeadbeef${"00".repeat(32)}`, { to: ARKIV_ADDRESS })
      } catch (e) {
        return e as UnknownSelectorError
      }
    })()
    expect(error!.targetIsRegistry).toBe(true)
    expect(error!.message).toContain(ARKIV_ADDRESS)
  })

  test("a serialized transaction to the registry with an unknown selector is flagged too", () => {
    const serialized = serializeTransaction({
      type: "eip1559",
      chainId: 7733102,
      to: ARKIV_ADDRESS,
      nonce: 0,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      gas: 21_000n,
      data: `0xdeadbeef${"00".repeat(32)}`,
    })
    try {
      decodeArkivTransaction(serialized)
      throw new Error("expected a throw")
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownSelectorError)
      expect((e as UnknownSelectorError).targetIsRegistry).toBe(true)
    }
  })

  test("plainly foreign data is still a plain DecodeError", () => {
    try {
      decodeArkivTransaction(toHex("garbage"))
      throw new Error("expected a throw")
    } catch (e) {
      expect(e).toBeInstanceOf(DecodeError)
      expect(e).not.toBeInstanceOf(UnknownSelectorError)
      expect((e as DecodeError).code).toBe("NOT_ARKIV_CALLDATA")
    }
  })
})

describe("resolveExpiry", () => {
  test("takes the later of the absolute and the relative expiry", () => {
    expect(resolveExpiry(0n, 900n, 241_669n)).toBe(242_569n)
    expect(resolveExpiry(300_000n, 900n, 241_669n)).toBe(300_000n)
    expect(resolveExpiry(242_000n, 900n, 241_669n)).toBe(242_569n)
  })
})
