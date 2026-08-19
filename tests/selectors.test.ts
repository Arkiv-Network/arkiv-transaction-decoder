import { describe, expect, test } from "bun:test"
import { keccak256, toFunctionSelector, toHex } from "viem"
import { EXECUTE_V2_ABI, EXECUTE_V2_SELECTOR, REGISTRY_SIGNATURES } from "../src/abi"
import { ENTITY_EXECUTE_ABI, LEGACY_EXECUTE_SELECTOR } from "../src/decoder"

/**
 * Mirrors selectors_are_pinned in Arkiv-Network/arkiv crates/arkiv-bindings/src/lib.rs.
 *
 * The registry ABI in src/abi.ts is a hand-maintained copy of a struct another team
 * owns in another repo. That copy is how selector 0x49650044 was missed for weeks. Both
 * paths below are needed and must not share an input: path 1 alone passes even when the
 * ABI object is wrong, path 2 alone passes when someone edits the pin to match a broken
 * ABI. Together, changing a struct fails path 2 and changing a pin fails path 1.
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

/** Pinned so the receipt cross-checks in cheesecake.test.ts cannot drift silently. */
export const EVENT_TOPICS = {
  "EntityCreated(bytes32,address,uint64,uint8)":
    "0xb282d7c494b8899aa8015cd07be621530beb03409eb8c5e8fdc1411ba64356a5",
  "EntityPatched(bytes32,address)": "0xe986ee220b2d7947a009d9389d8400b2ac82d3b430a9f72700a0975d3d5a34fe",
  "ExpiryExtended(bytes32,address,uint64)":
    "0x10dc3526654c9ba4e2370b1bfcbc0de087d141a5694b3d3305d37df7e6705d4b",
  "OwnershipTransferred(bytes32,address,address)":
    "0x0b659dccc8eb950324170e8d9598af5ee04ee070883eb28651a96788721fbf83",
  "EntityDeleted(bytes32,address)": "0x4059b76c47e1ecc40ba88e649b654f716515eb358c3ce83c803820e3b3130cc3",
} as const

describe("registry event topics are pinned", () => {
  test.each(Object.entries(EVENT_TOPICS))("%s hashes to %s", (signature, topic) => {
    expect(keccak256(toHex(signature))).toBe(topic)
  })
})
