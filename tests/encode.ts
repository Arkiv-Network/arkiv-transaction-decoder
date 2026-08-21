// Encoding helpers for the registry ABI, used to build realistic
// execute((uint8,bytes)[]) calldata as test vectors.
import { type Address, type Hex, encodeAbiParameters, encodeFunctionData, toHex } from "viem"
import {
  ArkivAttributeType,
  ArkivOperationTag,
  CREATE_PARAMS,
  DELETE_PARAMS,
  EXECUTE_ABI,
  EXTEND_EXPIRY_PARAMS,
  PATCH_PARAMS,
  TRANSFER_OWNERSHIP_PARAMS,
} from "../src/abi"

export type RawAttribute = { name: Hex; typeId: number; value: Hex }
export type RawOperation = { operation: number; operationData: Hex }

/** 32-byte right-aligned word. Negative values are encoded two's complement, as on chain. */
export function word(value: bigint): Hex {
  return toHex(BigInt.asUintN(256, value), { size: 32 })
}

export function attribute(name: string, typeId: number, value: Hex): RawAttribute {
  return { name: toHex(name, { size: 32 }), typeId, value }
}

export const attr = {
  tombstone: (name: string) => attribute(name, ArkivAttributeType.Tombstone, "0x"),
  bool: (name: string, value: boolean) => attribute(name, ArkivAttributeType.Bool, word(value ? 1n : 0n)),
  i32: (name: string, value: number) => attribute(name, ArkivAttributeType.Int, word(BigInt(value))),
  u64: (name: string, value: bigint) => attribute(name, ArkivAttributeType.Uint64, word(value)),
  u256: (name: string, value: bigint) => attribute(name, ArkivAttributeType.Uint256, word(value)),
  /** value is the already-scaled integer, e.g. 1.5 is 1500000000000000000n at scale 1e18 */
  dec: (name: string, scaled: bigint) => attribute(name, ArkivAttributeType.Decimal, word(scaled)),
  bytes32: (name: string, value: Hex) => attribute(name, ArkivAttributeType.Bytes32, value),
  bytes: (name: string, value: Uint8Array) => attribute(name, ArkivAttributeType.Bytes, toHex(value)),
  str: (name: string, value: string) => attribute(name, ArkivAttributeType.Str, toHex(value)),
  addr: (name: string, value: Address) => attribute(name, ArkivAttributeType.Address, word(BigInt(value))),
  key: (name: string, value: Hex) => attribute(name, ArkivAttributeType.EntityKey, value),
}

export function createOp(params: {
  salt?: bigint
  expiresAt?: bigint
  minLifetime?: bigint
  creationFlags?: number
  attributes?: RawAttribute[]
}): RawOperation {
  return {
    operation: ArkivOperationTag.Create,
    operationData: encodeAbiParameters(CREATE_PARAMS, [
      {
        salt: params.salt ?? 1n,
        expiresAt: params.expiresAt ?? 0n,
        minLifetime: params.minLifetime ?? 0n,
        creationFlags: params.creationFlags ?? 0,
        attributes: params.attributes ?? [],
      },
    ]),
  }
}

export function patchOp(entityKey: Hex, mutations: RawAttribute[]): RawOperation {
  return {
    operation: ArkivOperationTag.Patch,
    operationData: encodeAbiParameters(PATCH_PARAMS, [{ entityKey, mutations }]),
  }
}

export function extendOp(entityKey: Hex, expiresAt: bigint, minLifetime: bigint): RawOperation {
  return {
    operation: ArkivOperationTag.ExtendExpiry,
    operationData: encodeAbiParameters(EXTEND_EXPIRY_PARAMS, [{ entityKey, expiresAt, minLifetime }]),
  }
}

export function transferOp(entityKey: Hex, newOwner: Address): RawOperation {
  return {
    operation: ArkivOperationTag.TransferOwnership,
    operationData: encodeAbiParameters(TRANSFER_OWNERSHIP_PARAMS, [{ entityKey, newOwner }]),
  }
}

export function deleteOp(entityKey: Hex): RawOperation {
  return {
    operation: ArkivOperationTag.Delete,
    operationData: encodeAbiParameters(DELETE_PARAMS, [{ entityKey }]),
  }
}

export function encodeExecute(ops: RawOperation[]): Hex {
  return encodeFunctionData({ abi: EXECUTE_ABI, functionName: "execute", args: [ops] })
}
