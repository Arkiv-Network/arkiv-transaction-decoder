import { describe, expect, test } from "bun:test"
import { keccak256, toFunctionSelector, toHex } from "viem"
import { EXECUTE_V2_ABI, EXECUTE_V2_SELECTOR, REGISTRY_SIGNATURES } from "../src/abi"
import { ENTITY_EXECUTE_ABI, LEGACY_EXECUTE_SELECTOR } from "../src/decoder"
import { EVENT_TOPICS } from "./topics"

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

describe("registry event topics are pinned", () => {
  test.each(Object.entries(EVENT_TOPICS))("%s hashes to %s", (signature, topic) => {
    expect(keccak256(toHex(signature))).toBe(topic)
  })
})
