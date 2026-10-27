// Encoding helpers mirroring @arkiv-network/sdk 0.9 (src/entity/operations.ts,
// src/schema/codec.ts), used to build execute() calldata as test vectors. They encode whatever
// they are given, malformed triples included, so the decoder's handling of those can be tested.
import { type Address, type Hex, encodeAbiParameters, encodeFunctionData, parseAbiParameters, toBytes, toHex } from "viem"
import { AttributeTypeId, EXECUTE_ABI, INDEXED_FLAG, OperationType } from "../src/decoder"

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

/** An attribute triple: an Ident32 name, a raw typeId byte, and the value bytes. */
export function cell(name: string, typeId: number, value: Hex): AbiAttribute {
  return { name: toHex(name, { size: 32 }), typeId, value }
}

/** A str cell, indexed unless asked otherwise (the SDK's default for a str). */
export function strCell(name: string, value: string, indexed = true): AbiAttribute {
  return cell(name, AttributeTypeId.Str | (indexed ? INDEXED_FLAG : 0), toHex(toBytes(value)))
}

/** A cell of one of the word types, whose value is always exactly 32 bytes. */
export function wordCell(name: string, type: AttributeTypeId, value: bigint, indexed = true): AbiAttribute {
  return cell(name, type | (indexed ? INDEXED_FLAG : 0), toHex(BigInt.asUintN(256, value), { size: 32 }))
}

/** A bytes cell: stored, never indexed. */
export function bytesCell(name: string, content: string | Uint8Array): AbiAttribute {
  const bytes = typeof content === "string" ? toBytes(content) : content
  return cell(name, AttributeTypeId.Bytes, toHex(bytes))
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
    operation: OperationType.Create,
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
    operation: OperationType.Patch,
    operationData: encodeAbiParameters(PATCH_PARAMS, [{ entityKey: params.entityKey, mutations: params.mutations ?? [] }]),
  }
}

export function extendOp(params: { entityKey: Hex; expiresAt?: bigint; minLifetime?: bigint }): Operation {
  return {
    operation: OperationType.Extend,
    operationData: encodeAbiParameters(EXTEND_PARAMS, [
      { entityKey: params.entityKey, expiresAt: params.expiresAt ?? 0n, minLifetime: params.minLifetime ?? 0n },
    ]),
  }
}

export function transferOp(params: { entityKey: Hex; newOwner: Address }): Operation {
  return {
    operation: OperationType.Transfer,
    operationData: encodeAbiParameters(TRANSFER_PARAMS, [{ entityKey: params.entityKey, newOwner: params.newOwner }]),
  }
}

export function deleteOp(entityKey: Hex): Operation {
  return {
    operation: OperationType.Delete,
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
