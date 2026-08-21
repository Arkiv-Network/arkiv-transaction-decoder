import { describe, expect, test } from "bun:test"
import type { Hex } from "viem"
import { ARKIV_ADDRESS } from "../src/abi"
import type { DecodedTransaction } from "../src/decode"
import { decodeArkivTransaction } from "../src/decoder"
import { EVENT_TOPICS } from "./topics"
import fixtures from "./fixtures/cheesecake.json"

/**
 * Real cheesecake devnet transactions, captured offline so CI needs no devnet and no
 * API key. The strongest check available: the calldata and the receipt logs are two
 * independent encodings of the same operations, so a decoder that silently mis-parses
 * disagrees here even when it returns plausible JSON.
 */

// transfer_ownership is mapped for completeness but no fixture exercises it: the cheesecake
// probes never transferred an entity, so tag 4 is covered only by the synthetic vectors in
// tests/decoder.test.ts.
const EVENT_FOR_OPERATION: Record<string, string> = {
  create: EVENT_TOPICS["EntityCreated(bytes32,address,uint64,uint8)"],
  patch: EVENT_TOPICS["EntityPatched(bytes32,address)"],
  extend_expiry: EVENT_TOPICS["ExpiryExtended(bytes32,address,uint64)"],
  transfer_ownership: EVENT_TOPICS["OwnershipTransferred(bytes32,address,address)"],
  delete: EVENT_TOPICS["EntityDeleted(bytes32,address)"],
}

type FixtureLog = { address: string; topics: string[]; data: string }
type Fixture = (typeof fixtures.transactions)[number]

function word(data: string, index: number): bigint {
  return BigInt(`0x${data.slice(2 + index * 64, 2 + (index + 1) * 64)}`)
}

function decode(fixture: Fixture): DecodedTransaction {
  return decodeArkivTransaction(fixture.input, {
    to: fixture.to as Hex,
    blockNumber: BigInt(fixture.blockNumber),
  }) as DecodedTransaction
}

describe("cheesecake devnet calldata", () => {
  test("the registry address in the fixtures is the one this decoder knows", () => {
    expect(fixtures.registry.toLowerCase()).toBe(ARKIV_ADDRESS.toLowerCase())
    for (const fixture of fixtures.transactions) {
      expect(fixture.status).toBe("0x1")
      expect(fixture.to.toLowerCase()).toBe(ARKIV_ADDRESS.toLowerCase())
    }
  })

  test.each(fixtures.transactions.map((f) => [f.label, f] as const))(
    "%s decodes and agrees with its receipt logs",
    (_label, fixture) => {
      const decoded = decode(fixture)
      expect(decoded.warning).toBeUndefined()

      // Count and order: one registry log per operation, in the same sequence.
      expect(decoded.operationCount).toBe(fixture.logs.length)
      expect(decoded.operations.map((op) => EVENT_FOR_OPERATION[op.operation])).toEqual(
        (fixture.logs as FixtureLog[]).map((log) => log.topics[0]),
      )

      decoded.operations.forEach((op, index) => {
        const log = fixture.logs[index] as FixtureLog

        // A create derives its key on chain, so the log is the only place it exists.
        if (op.operation === "create") {
          expect(op.entityKey).toBeNull()
          expect(op.salt).not.toBeNull()
          // EntityCreated(key, owner, expiresAt, creationFlags)
          expect(op.resolvedExpiresAt).toBe(word(log.data, 0).toString())
          expect(op.creationFlags).toBe(Number(word(log.data, 1)))
        } else {
          expect(op.entityKey?.toLowerCase()).toBe(log.topics[1]!.toLowerCase())
        }

        if (op.operation === "extend_expiry") {
          // ExpiryExtended(key, owner, expiresAt)
          expect(op.resolvedExpiresAt).toBe(word(log.data, 0).toString())
        }
      })
    },
  )

  test("the raw calldata expiry is not the on-chain expiry", () => {
    // The rule is max(expiresAt, block + minLifetime). Asserting equality against the
    // log without resolving is the trap: every live create carries expiresAt 0.
    const fixture = fixtures.transactions.find((f) => f.label === "create")!
    const op = decode(fixture).operations[0]!
    expect(op.expiresAt).toBe("0")
    expect(op.minLifetime).toBe("30")
    expect(op.resolvedExpiresAt).toBe(String(fixture.blockNumber + 30))
    expect(op.resolvedExpiresAt).not.toBe(op.expiresAt)
  })

  test("a create carries its payload inline as a $payload attribute", () => {
    const fixture = fixtures.transactions.find((f) => f.label === "create")!
    const op = decode(fixture).operations[0]!
    expect(op.contentType).toBe("application/json")
    expect(op.payload.size).toBe(44)
    expect(op.payload.text).toBe('{"probe":"smoke-readonly","run":"rmsysl2em"}')
    expect(op.systemAttributes.sort()).toEqual(["$contentType", "$payload"])
    // Lifted out, so the 44-byte blob does not land in an attribute value.
    expect(op.attributes.map((a) => a.key)).toEqual(["kind", "run"])
    expect(op.creationFlagNames).toEqual(["readonly"])
  })

  test("a patch carries a real tombstone", () => {
    const fixture = fixtures.transactions.find((f) => f.label === "patch")!
    const op = decode(fixture).operations[0]!
    expect(op.attributes).toEqual([
      { key: "flag", valueType: 0, valueTypeName: "tombstone", value: "", sizeBytes: 0 },
      { key: "rank", valueType: 2, valueTypeName: "i32", value: "2", sizeBytes: 32 },
      { key: "status", valueType: 8, valueTypeName: "str", value: "patched", sizeBytes: 7 },
    ])
  })

  test("a batch keeps its operations in calldata order", () => {
    const fixture = fixtures.transactions.find((f) => f.label === "batch")!
    const decoded = decode(fixture)
    expect(decoded.operations.map((op) => op.operation)).toEqual(["create", "create", "patch"])
    expect(decoded.operations.map((op) => op.index)).toEqual([0, 1, 2])
    // Two creates with the same lifetime but different salts, so different entities.
    expect(decoded.operations[0]!.salt).not.toBe(decoded.operations[1]!.salt)
  })

  test("every live operation is canonically encoded", () => {
    for (const fixture of fixtures.transactions) {
      const warnings = decode(fixture).warnings ?? []
      expect(warnings.filter((w) => w.includes("canonical"))).toEqual([])
    }
  })
})
