import type { Address, Hex } from "viem"

/**
 * The Arkiv entity-registry ABI this service decodes: `execute((uint8,bytes)[])`,
 * selector 0x49650044.
 *
 * One generation, because the chain runs one. Generation 1 lived on braga, which now
 * refuses connections, and on flan, which is NXDOMAIN and gone from the db-chain-networks
 * registry. The two live networks, cheesecake (7733102) and scx2 (7728681), are both
 * db-chain and both speak the ABI below; 1,106 of 1,106 sampled cheesecake registry
 * transactions carry 0x49650044 and none carry the old selector. Only those 4 retired
 * bytes survive, at the foot of this file, so a legacy chain coming back is named rather
 * than mistaken for foreign traffic.
 *
 * This is a hand-maintained copy. The source of truth is
 * Arkiv-Network/arkiv, crates/arkiv-bindings/src/lib.rs.
 * tests/selectors.test.ts recomputes every selector from its signature string and
 * asserts the pinned hex, mirroring that crate's `selectors_are_pinned` test, so an
 * upstream struct change fails the build here instead of becoming a silent 400.
 */

/** The registry contract, the same address on every Arkiv network. */
export const ARKIV_ADDRESS = "0x4400000000000000000000000000000000000044" as Address

// Ident32 is `type Ident32 is bytes32`, a Solidity user-defined value type. It flattens
// to a plain bytes32 on the wire and in the canonical signature, which is why the pinned
// selector reads attributeTypeId(bytes32,bytes32) and not attributeTypeId(Ident32,bytes32).
export const ATTRIBUTE_COMPONENTS = [
  { name: "name", type: "bytes32" },
  { name: "typeId", type: "uint8" },
  { name: "value", type: "bytes" },
] as const

export const EXECUTE_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "ops",
        type: "tuple[]",
        components: [
          { name: "operation", type: "uint8" },
          { name: "operationData", type: "bytes" },
        ],
      },
    ],
    outputs: [{ name: "keys", type: "bytes32[]" }],
  },
] as const

// Each operation's `operationData` is abi.encode(payloadStruct): the single-value
// encoding, so a dynamic struct is preceded by its 0x20 offset word and a static one
// is not. decodeAbiParameters with a one-element tuple list handles both uniformly.
export const CREATE_PARAMS = [
  {
    type: "tuple",
    components: [
      { name: "salt", type: "uint128" },
      { name: "expiresAt", type: "uint64" },
      { name: "minLifetime", type: "uint64" },
      { name: "creationFlags", type: "uint8" },
      { name: "attributes", type: "tuple[]", components: ATTRIBUTE_COMPONENTS },
    ],
  },
] as const

export const PATCH_PARAMS = [
  {
    type: "tuple",
    components: [
      { name: "entityKey", type: "bytes32" },
      { name: "mutations", type: "tuple[]", components: ATTRIBUTE_COMPONENTS },
    ],
  },
] as const

export const EXTEND_EXPIRY_PARAMS = [
  {
    type: "tuple",
    components: [
      { name: "entityKey", type: "bytes32" },
      { name: "expiresAt", type: "uint64" },
      { name: "minLifetime", type: "uint64" },
    ],
  },
] as const

export const TRANSFER_OWNERSHIP_PARAMS = [
  {
    type: "tuple",
    components: [
      { name: "entityKey", type: "bytes32" },
      { name: "newOwner", type: "address" },
    ],
  },
] as const

export const DELETE_PARAMS = [
  { type: "tuple", components: [{ name: "entityKey", type: "bytes32" }] },
] as const

/** Operation tags of the tagged union. There is no `expire` tag: expiry is a per-block system call. */
export enum ArkivOperationTag {
  Create = 1,
  Patch = 2,
  ExtendExpiry = 3,
  TransferOwnership = 4,
  Delete = 5,
}

export enum ArkivAttributeType {
  Tombstone = 0,
  Bool = 1,
  Int = 2,
  Uint64 = 3,
  Uint256 = 4,
  Decimal = 5,
  Bytes32 = 6,
  Bytes = 7,
  Str = 8,
  Address = 9,
  EntityKey = 10,
}

export const OPERATION_NAMES = {
  [ArkivOperationTag.Create]: "create",
  [ArkivOperationTag.Patch]: "patch",
  [ArkivOperationTag.ExtendExpiry]: "extend_expiry",
  [ArkivOperationTag.TransferOwnership]: "transfer_ownership",
  [ArkivOperationTag.Delete]: "delete",
} as const

export type ArkivOperationName = (typeof OPERATION_NAMES)[keyof typeof OPERATION_NAMES]

/** AttributeType::name() in arkiv-bindings. */
export const ATTRIBUTE_TYPE_NAMES = {
  [ArkivAttributeType.Tombstone]: "tombstone",
  [ArkivAttributeType.Bool]: "bool",
  [ArkivAttributeType.Int]: "i32",
  [ArkivAttributeType.Uint64]: "u64",
  [ArkivAttributeType.Uint256]: "u256",
  [ArkivAttributeType.Decimal]: "dec",
  [ArkivAttributeType.Bytes32]: "bytes32",
  [ArkivAttributeType.Bytes]: "bytes",
  [ArkivAttributeType.Str]: "str",
  [ArkivAttributeType.Address]: "addr",
  [ArkivAttributeType.EntityKey]: "key",
} as const

export type ArkivAttributeTypeName = (typeof ATTRIBUTE_TYPE_NAMES)[keyof typeof ATTRIBUTE_TYPE_NAMES]

export const CREATION_FLAG_READONLY = 0b0000_0001
export const CREATION_FLAG_PERMISSIONLESS_EXTENSION = 0b0000_0010
export const CREATION_FLAGS_MASK = CREATION_FLAG_READONLY | CREATION_FLAG_PERMISSIONLESS_EXTENSION

export const WORD_LEN = 32
/** Widest value a uint64 field can hold. Also the executor's marker for a permanent entity. */
export const U64_MAX = 2n ** 64n - 1n
export const DECIMAL_SCALE = 18n
export const MAX_PAYLOAD_BYTES = 131_072
export const MAX_STR_BYTES = 128
export const MAX_ATTRIBUTES = 32

/** The two system attributes a client may write. Both are lifted out of the attribute
 *  array into dedicated response fields, mirroring what the executor does on chain. */
export const PAYLOAD_ATTRIBUTE = "$payload"
export const CONTENT_TYPE_ATTRIBUTE = "$contentType"

// Pinned by hand, never computed: tests/selectors.test.ts compares the computed value
// against these. Copied from the selectors_are_pinned test in arkiv-bindings/src/lib.rs.
export const EXECUTE_SELECTOR = "0x49650044" as Hex
export const ENTITY_NONCE_SELECTOR = "0x36917bfd" as Hex
export const CUSTOM_ATTRIBUTE_NAMES_SELECTOR = "0x58d5418a" as Hex
export const ATTRIBUTE_TYPE_ID_SELECTOR = "0x434fb6f3" as Hex

export const REGISTRY_SIGNATURES = {
  "execute((uint8,bytes)[])": EXECUTE_SELECTOR,
  "entityNonce(address)": ENTITY_NONCE_SELECTOR,
  "customAttributeNames(bytes32)": CUSTOM_ATTRIBUTE_NAMES_SELECTOR,
  "attributeTypeId(bytes32,bytes32)": ATTRIBUTE_TYPE_ID_SELECTOR,
} as const

/** Registry read-only calls we recognise but do not decode. They carry no operations,
 *  but they are unambiguously registry traffic, so they must never be reported as
 *  "not an Arkiv call". */
export const VIEW_FUNCTION_NAMES = {
  [ENTITY_NONCE_SELECTOR]: "entityNonce",
  [CUSTOM_ATTRIBUTE_NAMES_SELECTOR]: "customAttributeNames",
  [ATTRIBUTE_TYPE_ID_SELECTOR]: "attributeTypeId",
} as const

export type ArkivViewFunctionName = (typeof VIEW_FUNCTION_NAMES)[keyof typeof VIEW_FUNCTION_NAMES]

// ---------------------------------------------------------------------------
// Generation 1, retired. Four bytes, no ABI.
// ---------------------------------------------------------------------------

/**
 * The generation-1 `execute(...)` selector. Its structs are gone from this repo: no live
 * network runs that ABI, so decoding it was code no caller could reach.
 *
 * Recognising it is not the same as decoding it, which is why the 4 bytes stay. Drop them
 * and generation-1 calldata becomes an unknown selector, indistinguishable from every
 * ERC20 transfer on the chain and answered with "not Arkiv calldata", which is false about
 * a registry call we can name with certainty. Kept, it answers as a RETIRED_GENERATION gap
 * under its own subject in the tally, so "a legacy chain is being indexed" and "the
 * registry grew a function we do not know" stay two different incidents.
 */
export const RETIRED_EXECUTE_SELECTOR = "0xba8ccf92" as Hex

/** Pinned like the live ones. tests/selectors.test.ts hashes this to the 4 bytes above,
 *  so the retired selector cannot rot into a typo now that no ABI object derives it. */
export const RETIRED_EXECUTE_SIGNATURE =
  "execute((uint8,bytes32,bytes,(bytes32[4]),(bytes32,uint8,bytes32[4])[],uint32,address)[])"
