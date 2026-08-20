// Encoding helpers mirroring @arkiv-network/sdk (src/entity/operations.ts for the current tagged
// union, src/utils/arkivTransactions.ts for the legacy struct), used to build realistic execute()
// calldata as test vectors.
import {
  type Address,
  type Hex,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbiParameters,
  toBytes,
  toHex,
} from "viem"
import {
  AttributeTypeId,
  AttributeValueType,
  EXECUTE_ABI,
  EntityOperationType,
  LEGACY_EXECUTE_ABI,
} from "../src/decoder"

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000"
const ZERO_32 = `0x${"00".repeat(32)}` as Hex
const EMPTY_BYTES128 = [ZERO_32, ZERO_32, ZERO_32, ZERO_32] as const

// --- current format: an operation tag plus the abi.encode of the struct it selects -----------

const ATTRIBUTE_TUPLE = "(bytes32 name, uint8 typeId, bytes value)[]"

const CREATE_PARAMS = parseAbiParameters(
  `(uint128 salt, uint64 expiresAt, uint64 minLifetime, uint8 creationFlags, ${ATTRIBUTE_TUPLE} attributes)`,
)
const PATCH_PARAMS = parseAbiParameters(`(bytes32 entityKey, ${ATTRIBUTE_TUPLE} mutations)`)
const EXTEND_PARAMS = parseAbiParameters("(bytes32 entityKey, uint64 expiresAt, uint64 minLifetime)")
const TRANSFER_PARAMS = parseAbiParameters("(bytes32 entityKey, address newOwner)")
const DELETE_PARAMS = parseAbiParameters("(bytes32 entityKey)")

export type Operation = { operation: number; operationData: Hex }

export type AbiAttribute = { name: Hex; typeId: number; value: Hex }

/** An attribute cell: an Ident32 name, a typeId, and the bytes that typeId selects. */
export function cell(name: string, typeId: number, value: Hex): AbiAttribute {
  return { name: toHex(name, { size: 32 }), typeId, value }
}

export function strCell(name: string, value: string): AbiAttribute {
  return cell(name, AttributeTypeId.Str, toHex(toBytes(value)))
}

/** A cell of one of the word types, whose value is always exactly 32 bytes. */
export function wordCell(name: string, typeId: number, value: bigint): AbiAttribute {
  return cell(name, typeId, toHex(BigInt.asUintN(256, value), { size: 32 }))
}

/** The `$payload` system cell — the one `bytes`-typed attribute an entity carries. */
export function payloadCell(payload: string | Uint8Array): AbiAttribute {
  const bytes = typeof payload === "string" ? toBytes(payload) : payload
  return cell("$payload", AttributeTypeId.Bytes, toHex(bytes))
}

/** The `$contentType` system cell. */
export function contentTypeCell(contentType: string): AbiAttribute {
  return strCell("$contentType", contentType)
}

/** A tombstone: the mutation that unsets an attribute, legal only in a patch. */
export function tombstoneCell(name: string): AbiAttribute {
  return cell(name, AttributeTypeId.Tombstone, "0x")
}

export function createOp(params: {
  salt?: bigint
  expiresAt?: bigint
  minLifetime?: bigint
  creationFlags?: number
  attributes?: AbiAttribute[]
}): Operation {
  return {
    operation: EntityOperationType.Create,
    operationData: encodeAbiParameters(CREATE_PARAMS, [
      {
        salt: params.salt ?? 0n,
        expiresAt: params.expiresAt ?? 0n,
        minLifetime: params.minLifetime ?? 0n,
        creationFlags: params.creationFlags ?? 0,
        attributes: params.attributes ?? [],
      },
    ]),
  }
}

export function patchOp(params: { entityKey: Hex; mutations?: AbiAttribute[] }): Operation {
  return {
    operation: EntityOperationType.Update,
    operationData: encodeAbiParameters(PATCH_PARAMS, [
      { entityKey: params.entityKey, mutations: params.mutations ?? [] },
    ]),
  }
}

export function extendOp(params: {
  entityKey: Hex
  expiresAt?: bigint
  minLifetime?: bigint
}): Operation {
  return {
    operation: EntityOperationType.Extend,
    operationData: encodeAbiParameters(EXTEND_PARAMS, [
      {
        entityKey: params.entityKey,
        expiresAt: params.expiresAt ?? 0n,
        minLifetime: params.minLifetime ?? 0n,
      },
    ]),
  }
}

export function transferOp(params: { entityKey: Hex; newOwner: Address }): Operation {
  return {
    operation: EntityOperationType.Transfer,
    operationData: encodeAbiParameters(TRANSFER_PARAMS, [
      { entityKey: params.entityKey, newOwner: params.newOwner },
    ]),
  }
}

export function deleteOp(entityKey: Hex): Operation {
  return {
    operation: EntityOperationType.Delete,
    operationData: encodeAbiParameters(DELETE_PARAMS, [{ entityKey }]),
  }
}

/** An operation carrying a tag no build knows, to check a batch still decodes around it. */
export function unknownOp(operation: number): Operation {
  return { operation, operationData: "0x" }
}

export function encodeExecute(ops: Operation[]): Hex {
  return encodeFunctionData({ abi: EXECUTE_ABI, functionName: "execute", args: [ops] })
}

// --- legacy format: one flat struct per operation -------------------------------------------

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

export function legacyAttribute(attr: { key: string; value: string | number | bigint | boolean }) {
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

export type LegacyOperation = {
  operationType: number
  entityKey: Hex
  payload: Hex
  contentType: { data: readonly [Hex, Hex, Hex, Hex] }
  attributes: ReturnType<typeof legacyAttribute>[]
  expiresAt: number
  newOwner: Address
}

export function legacyCreateOp(params: {
  entityKey: Hex
  payload: string | Uint8Array
  contentType: string
  attributes?: { key: string; value: string | number | bigint | boolean }[]
  expiresAtBlocks: number
}): LegacyOperation {
  return {
    operationType: EntityOperationType.Create,
    entityKey: params.entityKey,
    payload: toHex(typeof params.payload === "string" ? toBytes(params.payload) : params.payload),
    contentType: encodeMime128(params.contentType),
    attributes: (params.attributes ?? []).map(legacyAttribute),
    expiresAt: params.expiresAtBlocks,
    newOwner: ZERO_ADDRESS,
  }
}

export function legacyEmptyOp(operationType: number, entityKey: Hex): LegacyOperation {
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

export function encodeLegacyExecute(ops: LegacyOperation[]): Hex {
  return encodeFunctionData({ abi: LEGACY_EXECUTE_ABI, functionName: "execute", args: [ops] })
}
