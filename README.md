# arkiv-transaction-decoder

A small [Bun](https://bun.sh) server that decodes Arkiv entity-registry transaction data back into
human-readable Arkiv operations (create / patch / extend / transfer / delete), for chains that run
the UDC entity model of `@arkiv-network/sdk` 0.9: schema-typed attributes, no payload and no
content type.

The SDK encodes entity mutations as a call to the registry contract
(`0x4400000000000000000000000000000000000044`). A transaction is an ordered, atomic batch of
operations, each one an operation tag plus the ABI encoding of the struct that tag selects:

```solidity
function execute((uint8 operation, bytes operationData)[] ops) external returns (bytes32[] keys)
```

`operationData` is the `abi.encode` of a per-tag struct:

| tag | `operation` | `operationData`                                                                                     |
| --- | ----------- | --------------------------------------------------------------------------------------------------- |
| 1   | `create`    | `(uint128 salt, uint64 expiresAt, uint64 minLifetime, uint8 creationFlags, Attribute[] attributes)` |
| 2   | `patch`     | `(bytes32 entityKey, Attribute[] mutations)`                                                        |
| 3   | `extend`    | `(bytes32 entityKey, uint64 expiresAt, uint64 minLifetime)`                                         |
| 4   | `transfer`  | `(bytes32 entityKey, address newOwner)`                                                             |
| 5   | `delete`    | `(bytes32 entityKey)`                                                                               |

An attribute is `(bytes32 name, uint8 typeId, bytes value)`. The low seven bits of `typeId` are the
type (`1` bool, `2` i32, `3` u64, `4` u256, `5` dec, `6` bytes32, `7` bytes, `8` str, `9` addr,
`10` key) and bit 7 (`0x80`) asks the node to index the attribute, so an indexed str is `0x88` and
an unindexed one `0x08`. `bytes` is stored but never indexed. A `typeId` of `0` is a tombstone: the
patch mutation that unsets an attribute.

**`bytes` contents are never returned or logged**: a `bytes` attribute is reported as its size and
keccak256 alone. Fetch the content from the node (`arkiv_query` with `attributes` selected) when
you need it.

The service accepts either bare `execute()` calldata or a full RLP-serialized transaction (signed
or unsigned, legacy/2930/1559). It decodes exactly the calldata the node's `execute()` ABI layer
accepts (see [What the node refuses](#what-the-node-refuses)) and answers `400` for anything else,
including calldata in the pre-UDC struct format (selector `0xba8ccf92`).

## Run

```sh
bun install
bun start          # listens on :3000, override with PORT=...
```

## Docker

```sh
docker build -t arkiv-transaction-decoder:v0.3.0 .
docker run --rm -p 3000:3000 arkiv-transaction-decoder:v0.3.0
```

Pushing a Git tag such as `v0.3.0` builds and publishes the image to GitHub Container Registry:

```sh
git tag v0.3.0
git push origin v0.3.0
```

## API

The `/api` prefix is optional on every route: `/decode` and `/api/decode` are the same handler, so
the service serves both a gateway that mounts it under `/api` and a service-to-service caller that
posts to `<base>/decode`.

### `GET /api/version`

Returns the service name and the version in `package.json`:

```json
{
  "service": "arkiv-transaction-decoder",
  "version": "v0.3.0"
}
```

### `POST /api/decode`

Body: `{"data": "0x..."}` (JSON) or the raw hex string as `text/plain`.
Also available as `GET /api/decode?data=0x...`. Extra body fields, such as the `chainId` the chain
indexer sends, are ignored.

```sh
curl -s localhost:3000/api/decode \
  -H 'content-type: application/json' \
  -d '{"data": "0x49650044..."}'
```

Response (the create recorded in block 16 of the live UDC chain):

```json
{
  "functionName": "execute",
  "format": "udc",
  "operations": [
    {
      "operationType": 1,
      "operation": "create",
      "entityKey": null,
      "salt": "23664374352188590007044345904234168063",
      "creationFlags": 0,
      "expiresAt": "0",
      "minLifetime": "1800",
      "permanent": false,
      "newOwner": null,
      "bytesSize": 49,
      "attributes": [
        { "name": "body", "typeId": 7, "type": "bytes", "indexed": false, "value": null, "size": 49,
          "keccak256": "0x66b978bb371b2ca0ed21099b45937b8b06faa1027e50fe05da6417489cb3f74f" },
        { "name": "healthy", "typeId": 129, "type": "bool", "indexed": true, "value": true, "size": 32 },
        { "name": "height", "typeId": 3, "type": "u64", "indexed": false, "value": "0x124f80", "size": 32 },
        { "name": "level", "typeId": 130, "type": "i32", "indexed": true, "value": 42, "size": 32 },
        { "name": "mimeType", "typeId": 8, "type": "str", "indexed": false, "value": "application/json", "size": 16 },
        { "name": "tag", "typeId": 136, "type": "str", "indexed": true, "value": "health-1793045491029", "size": 20 }
      ]
    }
  ]
}
```

#### Operations

Every operation carries every field below, `null` where its tag has no such field, so a consumer
reads one shape whatever the tag. Operations come in calldata order, which is the order the node
applies them and emits their events in.

| field           | type              | set by           | meaning                                                                                                     |
| --------------- | ----------------- | ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `operationType` | number            | all              | the tag, 1–5                                                                                                |
| `operation`     | string            | all              | `create`, `patch`, `extend`, `transfer` or `delete`                                                         |
| `entityKey`     | hex \| null       | all but create   | lowercase. A create's key is derived by the engine; pair creates with the `EntityCreated` logs in order    |
| `salt`          | string \| null    | create           | the uint128 salt, decimal                                                                                   |
| `creationFlags` | number \| null    | create           | bit 0 readonly, bit 1 permissionless extension                                                              |
| `expiresAt`     | string \| null    | create, extend   | the absolute deadline as a block height, exact decimal; `"0"` when unset                                    |
| `minLifetime`   | string \| null    | create, extend   | the lifetime floor in blocks from the landing block, exact decimal; `"0"` when unset                        |
| `permanent`     | boolean \| null   | create, extend   | the operation asks for permanence through `expiresAt` = `18446744073709551615` (2^64−1); see below          |
| `newOwner`      | address \| null   | transfer         | lowercase                                                                                                   |
| `bytesSize`     | number            | all              | bytes held by the operation's `bytes` attributes together; `0` when it has none                             |
| `attributes`    | array             | all              | create: the attributes; patch: the mutations, tombstones included; otherwise `[]`                           |
| `error`         | string            | when refused     | present only when the node would refuse the operation as a whole; see below                                 |

The engine resolves an expiry pair at the landing block as `max(expiresAt, block + minLifetime)`;
the decoder does not know the block, so it reports the pair as the calldata carries it. That is
why only `permanent: true` is definitive: an entity is also permanent when `block + minLifetime`
reaches 2^64−1 exactly, which takes the landing block to know. To tell for certain, resolve the
pair against the block, or read the expiry from the operation's event.

A **patch** lists only what it changes, in calldata order. Each entry with a type sets that
attribute — adding it, or replacing its value, type and indexed flag with the ones given here —
and each tombstone removes it. Attributes a patch does not name are left as they were.

```json
{ "operationType": 2, "operation": "patch",
  "entityKey": "0x7c843d69df8b8f4e33ea1f29bc0a0b9df7906b023a0d43447ee128f5805e53ef",
  "salt": null, "creationFlags": null, "expiresAt": null, "minLifetime": null, "permanent": null,
  "newOwner": null, "bytesSize": 13,
  "attributes": [
    { "name": "body", "typeId": 7, "type": "bytes", "indexed": false, "value": null, "size": 13,
      "keccak256": "0x7fe4d11a6f2bed874122855aab1dd8cdaded0ddbbeb4b41660c4a1e7a4ef7cc6" },
    { "name": "drop", "typeId": 0, "type": "tombstone", "indexed": false, "value": null, "size": 0 },
    { "name": "level", "typeId": 130, "type": "i32", "indexed": true, "value": 2, "size": 32 }
  ] }
```

An **extend**, a **transfer** and a **delete** (block 52):

```json
{ "operationType": 3, "operation": "extend",
  "entityKey": "0xbfce939f3097613b0a36db64b8ae73ba9471c1be7e3df1be66a99baf6b5db93e",
  "salt": null, "creationFlags": null, "expiresAt": "0", "minLifetime": "3600", "permanent": false,
  "newOwner": null, "bytesSize": 0, "attributes": [] }
{ "operationType": 4, "operation": "transfer",
  "entityKey": "0xb947100ea15f87f0431329c7ccedb2c4f92d4726a9d8d2715c190890ffade240",
  "salt": null, "creationFlags": null, "expiresAt": null, "minLifetime": null, "permanent": null,
  "newOwner": "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", "bytesSize": 0, "attributes": [] }
{ "operationType": 5, "operation": "delete",
  "entityKey": "0x692204043c771fe340d6a2bca7a009784d5689296219d968cf9aed99857af329",
  "salt": null, "creationFlags": null, "expiresAt": null, "minLifetime": null, "permanent": null,
  "newOwner": null, "bytesSize": 0, "attributes": [] }
```

#### Attributes

| field       | type                           | meaning                                                                                       |
| ----------- | ------------------------------ | --------------------------------------------------------------------------------------------- |
| `name`      | string                         | the attribute name; names are case-sensitive                                                  |
| `typeId`    | number                         | the raw byte, indexed flag included                                                           |
| `type`      | string                         | `typeId & 0x7f` as its tag; `tombstone` for `0`; `invalid(0x..)` for a typeId the node refuses (`0x80`, `0x87`, an unknown type) |
| `indexed`   | boolean                        | `typeId & 0x80`                                                                               |
| `value`     | string \| number \| boolean \| null | see below; `null` for `bytes`, a tombstone, an `invalid(0x..)` type and a value that does not decode |
| `size`      | number                         | length of the value bytes as calldata carries them: 32 for a word type, the UTF-8 length of a str |
| `keccak256` | hex                            | `bytes` only: keccak256 of the content                                                         |
| `error`     | string                         | present only when the node would refuse the triple; see below                                 |

`value` is encoded exactly as the node's `arkiv_query` returns the same attribute, so the two
compare with plain JSON equality:

| type                     | `value`                                          | example                                          |
| ------------------------ | ------------------------------------------------ | ------------------------------------------------ |
| `bool`                   | JSON boolean                                     | `true`                                           |
| `i32`                    | JSON number                                      | `-10`                                            |
| `u64`, `u256`            | `0x` quantity, lowercase, no leading zeros       | `"0x1fffffffffffff"`, `"0x0"`                    |
| `dec`                    | decimal literal, trailing zeros trimmed          | `"3.5"`, `"-0.25"`, `"0"`                        |
| `bytes32`, `key`         | 32 bytes, lowercase `0x` hex                     | `"0xdede…dede"`                                  |
| `addr`                   | 20 bytes, lowercase `0x` hex                     | `"0x3ffcb8c66ba2a35df36d73b213399220fd59f42f"`   |
| `str`                    | the text                                         | `"hello"`                                        |
| `bytes`                  | `null`; see `size` and `keccak256`               |                                                  |

#### What the node refuses

The node refuses a transaction before it is mined if any part of it breaks its rules, so a decoded
chain transaction breaks none of them. The decoder still answers for calldata that has not been
mined, and treats the rules in two tiers, as the node does.

**Refused, `400`.** What the node's `execute()` ABI layer refuses (`InvalidArkivCalldata`,
`UnsupportedArkivOperation`) is not an Arkiv call the node accepts, and no part of it is decoded:

- input over 384 KiB (393216 bytes, the node's transaction cap), counting calldata or the whole
  serialized transaction;
- anything but the canonical ABI encoding, for the call and for each operation's struct: an offset
  that is not where the canonical encoding puts it (so no aliasing), a word with bits set above its
  type's width (`uint8` tag, typeId and flags, `uint64` expiry pair, `uint128` salt, `address`),
  non-zero padding, or data after the end;
- no operations, more than 128, an operation tag other than 1–5, or more than 32 attributes in one
  operation;
- hex that is not `0x`-prefixed or has an odd number of digits.

**Flagged, `200`.** What the node refuses triple by triple (`decode_protocol_triples`,
`validate`) comes back decoded, with an `error` on the triple or the operation, so a caller can show
what is wrong. A triple's `error` is the first of these that applies, in the order the node checks:

1. its name does not sort strictly after the previous triple's (byte order; this also catches
   duplicates);
2. its name is not NUL-padded UTF-8 (then `name` is the 32 bytes as hex), or is not a letter
   followed by letters, digits, `.`, `-` or `_`;
3. its typeId or value: an `invalid(0x..)` typeId, a word value that is not 32 bytes or out of
   range for its type (a `bool` other than 0 or 1, an `i32` that is not sign-extended, a `u64` or
   `addr` with high bits set), a `str` that is not UTF-8 or is longer than 128 bytes (control
   characters, NUL and DEL included, are UTF-8 like any other), a `bytes` value over 128 KiB, a
   tombstone in a create, or a tombstone with a value;
4. its name contains `--` or is a reserved word of the query language (`and`, `or`, `not`, `true`,
   `false`, `startswith`, `exists`, `typeof` and the ten type tags), in any case.

`value` is `null` only when the value itself does not decode (rule 3) or is a `bytes`; a triple
flagged for its name or its order keeps a value that decodes. An operation's `error` says its
`creationFlags` sets bits other than 1 and 2, or its `bytes` values together hold more than
128 KiB. The node also checks what only the chain state can tell (ownership, expiry, the size of
the entity a patch produces); the decoder does not.

#### Errors and serialized transactions

- For a serialized transaction the response also includes `to` (lowercase), plus a `warning` when
  the target is not the known Arkiv registry address.
- Input the node would refuse (above) returns `400` with `{"error": "..."}`, including calldata that
  is not an Arkiv `execute()` call at all, which is how a caller tells registry traffic from
  everything else. The message is fixed text: it never quotes the input.
- A request body over 1 MiB returns `413` unread; the largest input the node accepts fits well
  within it as JSON.
- Anything else, a fault of the decoder rather than of the input, returns `500`. A caller should
  retry it, not read it as "not Arkiv".

### `GET /api/health`

Returns `{"status": "ok"}`.

## Development

```sh
bun test           # run the test suite
bun run typecheck  # tsc --noEmit
bun run dev        # auto-reloading server
```

`tests/fixtures/live/` holds execute() transactions recorded from the live UDC chain (chain
7706815) together with the node's `arkiv_query` view of every entity they touch. `tests/live.test.ts`
checks each decode against its golden and each golden against the node. To record more, against a
node you can read from:

```sh
bun run scripts/record-live-fixtures.ts --rpc http://127.0.0.1:18545 --golden 16 22 48
```

The recorder only calls read-only methods. Review a new golden before committing it: the
cross-check against the node's view is what makes it a golden rather than a snapshot.

CI (GitHub Actions) runs typecheck + tests on every push and pull request.
