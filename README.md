# arkiv-transaction-decoder

A small [Bun](https://bun.sh) server that decodes Arkiv entity-registry transaction data back into
human-readable Arkiv operations (create / update / extend / transfer / delete).

The Arkiv SDK encodes entity mutations as a call to the registry contract
(`0x4400000000000000000000000000000000000044`). A transaction is an ordered, atomic batch of
operations, each one an operation tag plus the ABI encoding of the struct that tag selects:

```solidity
function execute((uint8 operation, bytes operationData)[] ops) external returns (bytes32[] keys)
```

`operationData` is the `abi.encode` of a per-tag struct — a tagged union, so a new operation is
additive rather than a change to `execute` itself:

| tag | operation           | `operationData`                                                                                              |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | `create`            | `(uint128 salt, uint64 expiresAt, uint64 minLifetime, uint8 creationFlags, Attribute[] attributes)`            |
| 2   | `update` (patch)    | `(bytes32 entityKey, Attribute[] mutations)`                                                                   |
| 3   | `extend`            | `(bytes32 entityKey, uint64 expiresAt, uint64 minLifetime)`                                                    |
| 4   | `transfer`          | `(bytes32 entityKey, address newOwner)`                                                                        |
| 5   | `delete`            | `(bytes32 entityKey)`                                                                                          |

where an attribute is `(bytes32 name, uint8 typeId, bytes value)` and `typeId` names the protocol's
value type (`1` bool, `2` i32, `3` u64, `4` u256, `5` dec, `6` bytes32, `7` bytes, `8` str,
`9` addr, `10` key; `0` marks a tombstone, the mutation that unsets an attribute).

An entity's payload and content type have no fields of their own: they travel as the system
attributes `$payload` (the one `bytes`-typed cell) and `$contentType` (a `str`). This service lifts
both back out into dedicated response fields, and reports the payload as a **size only** — entity
payload bytes are never returned or logged.

Blocks predating the tagged union carry the older struct format
(`execute((uint8 operationType, bytes32 entityKey, bytes payload, Mime128 contentType, Attribute[]
attributes, uint32 expiresAt, address newOwner)[])`, selector `0xba8ccf92`). Both are decoded; the
leading selector picks which.

The service accepts either bare `execute()` calldata or a full RLP-serialized transaction (signed
or unsigned, legacy/2930/1559) and returns the decoded operations as JSON.

## Run

```sh
bun install
bun start          # listens on :3000, override with PORT=...
```

## Docker

```sh
docker build -t arkiv-transaction-decoder:v0.2.0 .
docker run --rm -p 3000:3000 arkiv-transaction-decoder:v0.2.0
```

Pushing a Git tag such as `v0.2.0` builds and publishes the image to GitHub Container Registry:

```sh
git tag v0.2.0
git push origin v0.2.0
```

## API

The `/api` prefix is optional on every route: `/decode` and `/api/decode` are the same handler, so
the service serves both a gateway that mounts it under `/api` and a service-to-service caller that
posts to `<base>/decode`.

### `GET /api/version`

Returns the service name and version:

```json
{
  "service": "arkiv-transaction-decoder",
  "version": "v0.2.0"
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

Response:

```json
{
  "functionName": "execute",
  "format": "tagged",
  "operations": [
    {
      "operationType": 1,
      "operation": "create",
      "entityKey": null,
      "payload": { "size": 11 },
      "contentType": "text/plain",
      "attributes": [
        { "key": "category", "valueType": 8, "valueTypeName": "str", "value": "greeting" },
        { "key": "version", "valueType": 3, "valueTypeName": "u64", "value": "42" }
      ],
      "expiresAtBlocks": 1800,
      "approxExpiresInSeconds": 3600,
      "newOwner": null,
      "expiresAt": 0,
      "minLifetime": 1800,
      "salt": "42",
      "creationFlags": 0
    }
  ]
}
```

Notes:

- `entityKey` is `null` for a create: the engine derives the key from the owner, its entity nonce
  and the salt, and calldata alone carries none of the first two.
- `expiresAt` (an absolute block height) and `minLifetime` (a lifetime in blocks) are the pair the
  wire carries. `expiresAtBlocks` is the single block count to store: the lifetime, or the absolute
  deadline when that is all the operation gave. A uint64 too large for a JSON number — a
  never-expiring entity carries `2**64-1` — is clamped to `Number.MAX_SAFE_INTEGER`.
- `approxExpiresInSeconds` assumes the 2-second Arkiv block time, and is 0 for a purely absolute
  deadline.
- `payload` reports `size` alone. Legacy-format operations additionally carry `payload.hex`, and
  `payload.text` when those bytes are valid UTF-8.
- `format` is `"tagged"` for the current encoding and `"legacy"` for the struct format.
- For a serialized transaction the response also includes `to`, plus a `warning` when the target
  is not the known Arkiv registry address.
- Decoding errors return `400` with `{"error": "..."}` — including calldata that is not an Arkiv
  `execute()` call at all, which is how a caller tells registry traffic from everything else.

### `GET /api/health`

Returns `{"status": "ok"}`.

## Development

```sh
bun test           # run the test suite
bun run typecheck  # tsc --noEmit
bun run dev        # auto-reloading server
```

`sample-execute-calldata.txt` is a real 52 KB create recorded from the cheesecake devnet, decoded
by the test suite as a check against the live chain encoding.

CI (GitHub Actions) runs typecheck + tests on every push and pull request.
