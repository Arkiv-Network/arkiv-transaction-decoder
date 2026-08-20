import { describe, expect, test } from "bun:test"
import { keccak256, toFunctionSelector, toHex } from "viem"
import { EXECUTE_V2_ABI, EXECUTE_V2_SELECTOR, REGISTRY_SIGNATURES } from "../src/abi"
import { ENTITY_EXECUTE_ABI, LEGACY_EXECUTE_SELECTOR, decodeOperationV2 } from "../src/decoder"
import { EVENT_TOPICS } from "./topics"
import operationVectors from "./fixtures/operation-vectors.json"

/**
 * Mirrors selectors_are_pinned in Arkiv-Network/arkiv crates/arkiv-bindings/src/lib.rs.
 *
 * The registry ABI in src/abi.ts is a hand-maintained copy of a struct another team
 * owns in another repo. That copy is how selector 0x49650044 was missed for weeks. Both
 * paths below are needed and must not share an input: path 1 alone passes even when the
 * ABI object is wrong, path 2 alone passes when someone edits the pin to match a broken
 * ABI. Together, changing a struct fails path 2 and changing a pin fails path 1.
 *
 * What a pinned selector cannot catch is the drift that is most likely to happen. The
 * tagged union exists precisely so new operation types ship without touching the execute
 * signature (arkiv-bindings/src/lib.rs:12-17), and operationData is opaque bytes, so adding
 * a field to Create moves no selector at all and every test here still passes.
 *
 * The decode of real calldata is what catches that: tests/fixtures/cheesecake.json first,
 * and the frozen vectors below as its backstop. The fixture can be regenerated against a
 * newer chain, at which point it agrees with whatever the chain now sends and stops being
 * evidence; these vectors were captured once and never move, so a struct that grew a field
 * fails them.
 */
describe("registry selectors are pinned", () => {
  test.each(Object.entries(REGISTRY_SIGNATURES))(
    "the signature string %s hashes to %s",
    (signature, selector) => {
      expect(keccak256(toHex(signature)).slice(0, 10)).toBe(selector)
    },
  )

  test("the ABI object we decode with produces the pinned execute selector", () => {
    expect(toFunctionSelector(EXECUTE_V2_ABI[0])).toBe(EXECUTE_V2_SELECTOR)
  })

  test("the legacy ABI object still produces the legacy selector", () => {
    expect(toFunctionSelector(ENTITY_EXECUTE_ABI[0])).toBe("0xba8ccf92")
    expect(LEGACY_EXECUTE_SELECTOR).toBe("0xba8ccf92")
  })

  test("the two generations do not share a selector", () => {
    expect(EXECUTE_V2_SELECTOR).not.toBe(LEGACY_EXECUTE_SELECTOR)
  })
})

describe("one frozen operationData per tag still decodes", () => {
  type Vector = (typeof operationVectors.vectors)[number]

  test("every operation tag has a vector", () => {
    expect(operationVectors.vectors.map((v) => v.tag)).toEqual([1, 2, 3, 4, 5])
  })

  test.each(operationVectors.vectors.map((v) => [v.operation, v] as const))(
    "%s decodes to the same operation it did when it was captured",
    (_name, vector: Vector) => {
      const warnings: string[] = []
      const decoded = decodeOperationV2(
        { operation: vector.tag, operationData: vector.operationData as `0x${string}` },
        0,
        { blockNumber: null, payloadHexLimit: 8192 },
        warnings,
      )

      expect(decoded.undecodable).toBeUndefined()
      // A struct that gained a field re-encodes to different bytes, so this fires first.
      expect(warnings).toEqual([])
      for (const [field, value] of Object.entries(vector.expect)) {
        expect({ [field]: decoded[field as keyof typeof decoded] }).toEqual({ [field]: value })
      }
      expect(decoded.payload.size).toBe(vector.expectPayloadSize)
      expect(
        decoded.attributes.map((a) => ({
          key: a.key,
          valueTypeName: a.valueTypeName as string,
          value: a.value,
        })),
      ).toEqual(vector.expectAttributes)
    },
  )
})

describe("registry event topics are pinned", () => {
  test.each(Object.entries(EVENT_TOPICS))("%s hashes to %s", (signature, topic) => {
    expect(keccak256(toHex(signature))).toBe(topic)
  })
})
