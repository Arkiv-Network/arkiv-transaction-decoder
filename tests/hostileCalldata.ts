/**
 * Calldata a stranger can put in a block, plus the edge cases ordinary clients reach.
 *
 * Every entry here is something arkiv-chain-indexer can forward: it calls this service for
 * any transaction aimed at the registry, and a reverted transaction is still in the block,
 * so none of this has to succeed on chain to arrive. tests/statusInvariant.test.ts replays
 * the corpus and holds every answer to 200 or 400.
 */
import { type Hex, serializeTransaction } from "viem"
import {
  ArkivAttributeType,
  ARKIV_ADDRESS,
  ENTITY_NONCE_SELECTOR,
  EXECUTE_V2_SELECTOR,
  LEGACY_EXECUTE_SELECTOR,
  MAX_ATTRIBUTES,
  MAX_STR_BYTES,
} from "../src/abi"
import { MAX_INPUT_BYTES } from "../src/server"
import { attr, attribute, createOpV2, deleteOpV2, encodeExecuteV2, word } from "./encodeV2"

const ENTITY_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111" as const
const ZERO_WORD = "00".repeat(32)

/** A create's operationData is abi.encode(tuple), so the tuple is behind a 0x20 offset. */
function createDataWithAttributeCount(count: bigint): Hex {
  return `0x${[
    word(32n), // offset to the tuple
    word(1n), // salt
    word(0n), // expiresAt
    word(0n), // minLifetime
    word(0n), // creationFlags
    word(160n), // offset to attributes, from the tuple start
    word(count), // declared attribute count, with nothing behind it
  ]
    .map((w) => w.slice(2))
    .join("")}`
}

export type HostileCase = { name: string; data: string }

export const HOSTILE_CALLDATA: HostileCase[] = [
  // --- not hex at all ---
  { name: "empty string", data: "" },
  { name: "0x and nothing else", data: "0x" },
  { name: "plain text", data: "hello world" },
  { name: "non-hex digits after 0x", data: "0xZZZZZZZZ" },
  { name: "odd-length hex", data: "0x123" },
  { name: "hex without the 0x prefix", data: "49650044" },
  { name: "emoji in the data field", data: "0x\u{1F600}" },
  { name: "whitespace only", data: "   " },
  { name: "a JSON fragment in the data field", data: '{"data":"0x"}' },

  // --- truncated input ---
  { name: "one byte", data: "0xff" },
  { name: "three bytes, short of a selector", data: "0x496500" },
  { name: "execute selector alone", data: EXECUTE_V2_SELECTOR },
  { name: "execute selector plus one byte", data: `${EXECUTE_V2_SELECTOR}ff` },
  { name: "execute selector plus half a word", data: `${EXECUTE_V2_SELECTOR}${"00".repeat(16)}` },
  { name: "execute selector plus a bare offset word", data: `${EXECUTE_V2_SELECTOR}${word(32n).slice(2)}` },
  { name: "legacy selector with garbage", data: `${LEGACY_EXECUTE_SELECTOR}deadbeef` },
  { name: "view selector with garbage", data: `${ENTITY_NONCE_SELECTOR}ff` },
  { name: "view selector alone", data: ENTITY_NONCE_SELECTOR },

  // --- a declared length or offset past the buffer ---
  {
    name: "operation array length past the buffer",
    data: `${EXECUTE_V2_SELECTOR}${word(32n).slice(2)}${word(0xffffffffn).slice(2)}`,
  },
  {
    name: "operation array length at uint256 max",
    data: `${EXECUTE_V2_SELECTOR}${word(32n).slice(2)}${word(2n ** 256n - 1n).slice(2)}`,
  },
  {
    name: "operation array offset past the buffer",
    data: `${EXECUTE_V2_SELECTOR}${word(0xffffffffn).slice(2)}`,
  },
  {
    name: "operation array offset at uint256 max",
    data: `${EXECUTE_V2_SELECTOR}${word(2n ** 256n - 1n).slice(2)}`,
  },
  {
    name: "attribute count past the buffer",
    data: encodeExecuteV2([{ operation: 1, operationData: createDataWithAttributeCount(0xffffffffn) }]),
  },
  {
    name: "attribute count at uint256 max",
    data: encodeExecuteV2([{ operation: 1, operationData: createDataWithAttributeCount(2n ** 256n - 1n) }]),
  },
  {
    name: "operationData length past the buffer",
    data: `${EXECUTE_V2_SELECTOR}${word(32n).slice(2)}${word(1n).slice(2)}${word(32n).slice(2)}${word(1n).slice(2)}${word(0xffffffffn).slice(2)}`,
  },

  // --- an unknown selector ---
  { name: "unknown selector", data: `0xdeadbeef${ZERO_WORD}` },
  { name: "unknown selector with no arguments", data: "0xdeadbeef" },
  { name: "unknown selector that looks like execute", data: `0x49650045${word(32n).slice(2)}${word(0n).slice(2)}` },

  // --- an unknown operation tag ---
  { name: "operation tag 0", data: encodeExecuteV2([{ operation: 0, operationData: "0x" }]) },
  { name: "operation tag 6, the next one the protocol adds", data: encodeExecuteV2([{ operation: 6, operationData: "0x" }]) },
  { name: "operation tag 255", data: encodeExecuteV2([{ operation: 255, operationData: "0xdeadbeef" }]) },
  {
    name: "a batch that is all unknown tags",
    data: encodeExecuteV2([6, 7, 8, 9].map((operation) => ({ operation, operationData: "0x" }))),
  },
  {
    name: "an unknown tag between two good operations",
    data: encodeExecuteV2([deleteOpV2(ENTITY_KEY), { operation: 6, operationData: "0x" }, deleteOpV2(ENTITY_KEY)]),
  },

  // --- malformed operationData under a known tag ---
  { name: "known tag, empty operationData", data: encodeExecuteV2([{ operation: 5, operationData: "0x" }]) },
  { name: "known tag, two junk bytes", data: encodeExecuteV2([{ operation: 5, operationData: "0x1234" }]) },
  { name: "known tag, one word short", data: encodeExecuteV2([{ operation: 1, operationData: `0x${ZERO_WORD}` }]) },
  { name: "malformed argument block under our own selector", data: `${EXECUTE_V2_SELECTOR}deadbeef` },

  // --- hostile attribute values ---
  {
    name: "non-UTF8 bytes in a str attribute",
    data: encodeExecuteV2([createOpV2({ attributes: [attribute("note", ArkivAttributeType.Str, "0xfffefdfc")] })]),
  },
  {
    name: "a lone UTF-16 surrogate in a str attribute",
    data: encodeExecuteV2([createOpV2({ attributes: [attribute("note", ArkivAttributeType.Str, "0xeda080")] })]),
  },
  {
    name: "non-UTF8 bytes in $contentType",
    data: encodeExecuteV2([createOpV2({ attributes: [attribute("$contentType", ArkivAttributeType.Str, "0xff")] })]),
  },
  {
    name: "a str attribute above the protocol limit",
    data: encodeExecuteV2([
      createOpV2({ attributes: [attribute("note", ArkivAttributeType.Str, `0x${"41".repeat(MAX_STR_BYTES * 4)}`)] }),
    ]),
  },
  {
    name: "an attribute type the protocol has not defined",
    data: encodeExecuteV2([createOpV2({ attributes: [attribute("note", 200, `0x${ZERO_WORD}`)] })]),
  },
  {
    name: "a fixed-width attribute carrying the wrong number of bytes",
    data: encodeExecuteV2([createOpV2({ attributes: [attribute("n", ArkivAttributeType.Uint64, "0xff")] })]),
  },
  {
    name: "more attributes than the protocol allows",
    data: encodeExecuteV2([
      createOpV2({
        attributes: Array.from({ length: MAX_ATTRIBUTES * 4 }, (_, i) => attr.u64(`k${i}`, BigInt(i))),
      }),
    ]),
  },
  {
    name: "an empty attribute name",
    data: encodeExecuteV2([createOpV2({ attributes: [attr.u64("", 1n)] })]),
  },

  // --- empty and degenerate batches ---
  { name: "empty batch", data: encodeExecuteV2([]) },
  { name: "a create with no attributes", data: encodeExecuteV2([createOpV2({})]) },
  {
    name: "expiresAt at uint64 max, the executor's permanence marker",
    data: encodeExecuteV2([createOpV2({ expiresAt: 2n ** 64n - 1n, minLifetime: 2n ** 64n - 1n })]),
  },

  // --- serialized transactions ---
  {
    name: "a serialized transaction to the registry with an unknown selector",
    data: serializeTransaction({
      type: "eip1559",
      chainId: 7733102,
      to: ARKIV_ADDRESS,
      nonce: 0,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      gas: 21_000n,
      data: `0xdeadbeef${ZERO_WORD}`,
    }),
  },
  {
    name: "a serialized transaction to the registry carrying no calldata",
    data: serializeTransaction({
      type: "eip1559",
      chainId: 7733102,
      to: ARKIV_ADDRESS,
      nonce: 0,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      gas: 21_000n,
    }),
  },
  { name: "RLP that is not a transaction", data: "0x02c0" },
  { name: "an RLP list header promising more than it carries", data: "0x02f8ff01" },
]

/**
 * What a transaction can be, which is what bounds every body this service can ever get.
 *
 * arkiv-chain-indexer forwards one transaction's calldata per request, and the txpool caps
 * a transaction at 128 KB: arkiv-op-node core/txpool/legacypool/legacypool.go:54-61 sets
 * txSlotSize = 32 * 1024 and txMaxSize = 4 * txSlotSize, with `16 * txSlotSize // 512KB`
 * commented out directly above, so a raise to 512 KB is already contemplated there. Sizes
 * below come from those two numbers and nothing else. MAX_PAYLOAD_BYTES is the wrong ruler:
 * it is a per-payload protocol limit and says nothing about what fits in a transaction.
 */
const TX_MAX_SIZE_BYTES = 131_072
const CONTEMPLATED_TX_MAX_SIZE_BYTES = 524_288

/** One create carrying `payloadBytes` in $payload, so the calldata is a little above it. */
function createCarrying(payloadBytes: number): string {
  return encodeExecuteV2([
    createOpV2({
      minLifetime: 100n,
      attributes: [
        attr.str("$contentType", "application/octet-stream"),
        attr.bytes("$payload", new Uint8Array(payloadBytes)),
      ],
    }),
  ])
}

/** `0x` plus hex, so the string is 2 * bytes + 2 characters long. */
function hexOfBytes(bytes: number): string {
  return `0x${"ab".repeat(bytes)}`
}

/**
 * Bodies the size of real traffic. None of these may ever be refused.
 *
 * Each one is a fraction over its transaction cap, since the payload alone is that size and
 * the encoding adds to it, so decoding these proves the real thing decodes. They are the
 * half of the corpus a too-low MAX_INPUT_BYTES breaks, and the half the old fraction-sized
 * cases never contained.
 *
 * Built on call rather than at module scope, because each entry costs a megabyte.
 */
export function chainSizedCalldata(): HostileCase[] {
  return [
    { name: "a create carrying today's 128 KB transaction cap", data: createCarrying(TX_MAX_SIZE_BYTES) },
    largestChainSizedCalldata(),
  ]
}

/** The biggest body this service can ever be sent, once the contemplated 512 KB lands. */
export function largestChainSizedCalldata(): HostileCase {
  return {
    name: "a create carrying the contemplated 512 KB transaction cap",
    data: createCarrying(CONTEMPLATED_TX_MAX_SIZE_BYTES),
  }
}

/**
 * Bodies above the cap, sized in ABSOLUTE bytes.
 *
 * These used to be fractions of MAX_INPUT_BYTES, and that made them blind: the inputs shrank
 * in lockstep with the ceiling, so the suite could not build a body larger than the cap at
 * any cap value, and `MAX_INPUT_BYTES=100000 bun test` passed on a decoder that Bun would
 * 413 on a real 128 KB transaction. A test that scales with the thing it tests cannot test
 * it. The absolute case sits above MIN_INPUT_BYTES, so the oversize path is exercised at the
 * smallest legal cap; the relative case keeps exercising it when an operator raises the cap,
 * and it can no longer shrink under real traffic because the floor holds it at 2 MiB.
 */
export function oversizeCalldata(): HostileCase[] {
  return [oversizeAboveTheFloor(), capRelativeOversize()]
}

/**
 * Above the configured cap whatever it is set to, so the oversize path is still exercised
 * when an operator raises MAX_INPUT_BYTES. Relative on purpose, and safe now in a way it was
 * not before: the floor holds it at 2 MiB, so it can no longer shrink under real traffic.
 */
export function capRelativeOversize(): HostileCase {
  return { name: "just above MAX_INPUT_BYTES, whatever it is set to", data: hexOfBytes(Math.ceil(MAX_INPUT_BYTES / 2)) }
}

/**
 * 3 MiB of characters: half again over MIN_INPUT_BYTES, so it is oversize at the smallest
 * cap this service will start with, and it does not move when the cap does.
 */
export function oversizeAboveTheFloor(): HostileCase {
  return { name: "a 3 MiB body, above the 2 MiB floor under MAX_INPUT_BYTES", data: hexOfBytes((3 * 1024 * 1024) / 2) }
}
