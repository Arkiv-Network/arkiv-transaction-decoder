// Encoding helpers mirroring @arkiv-network/sdk src/utils/arkivTransactions.ts,
// used to build realistic execute() calldata as test vectors.
import { type Address, type Hex, encodeFunctionData, toBytes, toHex } from "viem"
import { AttributeValueType, ENTITY_EXECUTE_ABI, EntityOperationType } from "../src/decoder"

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000"
const ZERO_32 = `0x${"00".repeat(32)}` as Hex
const EMPTY_BYTES128 = [ZERO_32, ZERO_32, ZERO_32, ZERO_32] as const

export function encodeBytes128(data: Uint8Array): readonly [Hex, Hex, Hex, Hex] {
  const padded = new Uint8Array(128)
  padded.set(data.slice(0, 128))
  return [
    toHex(padded.slice(0, 32)),
    toHex(padded.slice(32, 64)),
    toHex(padded.slice(64, 96)),
    toHex(padded.slice(96, 128)),
  ]
}

export function encodeMime128(contentType: string): { data: readonly [Hex, Hex, Hex, Hex] } {
  return { data: contentType ? encodeBytes128(toBytes(contentType)) : EMPTY_BYTES128 }
}

export function encodeAttribute(attr: { key: string; value: string | number | bigint | boolean }) {
  const name = toHex(attr.key, { size: 32 })
  if (typeof attr.value === "string") {
    return {
      name,
      valueType: AttributeValueType.String,
      value: encodeBytes128(toBytes(attr.value)),
    }
  }
  const numVal = typeof attr.value === "boolean" ? (attr.value ? 1n : 0n) : BigInt(attr.value)
  return {
    name,
    valueType: AttributeValueType.Uint,
    value: [toHex(numVal, { size: 32 }), ZERO_32, ZERO_32, ZERO_32] as const,
  }
}

export type RawAttribute = {
  name: Hex
  valueType: number
  value: readonly [Hex, Hex, Hex, Hex]
}

/** Build an attribute with an arbitrary value type, including ones the decoder does not know. */
export function rawAttribute(key: string, valueType: number, value: Uint8Array): RawAttribute {
  return { name: toHex(key, { size: 32 }), valueType, value: encodeBytes128(value) }
}

export type RawOperation = {
  operationType: number
  entityKey: Hex
  payload: Hex
  contentType: { data: readonly [Hex, Hex, Hex, Hex] }
  attributes: RawAttribute[]
  expiresAt: number
  newOwner: Address
}

export function createOp(params: {
  entityKey: Hex
  payload: string | Uint8Array
  contentType: string
  attributes?: { key: string; value: string | number | bigint | boolean }[]
  expiresAtBlocks: number
}): RawOperation {
  return {
    operationType: EntityOperationType.Create,
    entityKey: params.entityKey,
    payload: toHex(typeof params.payload === "string" ? toBytes(params.payload) : params.payload),
    contentType: encodeMime128(params.contentType),
    attributes: (params.attributes ?? []).map(encodeAttribute),
    expiresAt: params.expiresAtBlocks,
    newOwner: ZERO_ADDRESS,
  }
}

export function emptyOp(operationType: number, entityKey: Hex): RawOperation {
  return {
    operationType,
    entityKey,
    payload: "0x",
    contentType: encodeMime128(""),
    attributes: [],
    expiresAt: 0,
    newOwner: ZERO_ADDRESS,
  }
}

export function encodeExecute(ops: RawOperation[]): Hex {
  return encodeFunctionData({ abi: ENTITY_EXECUTE_ABI, functionName: "execute", args: [ops] })
}
