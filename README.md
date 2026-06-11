# arkiv-transaction-decoder

A small [Bun](https://bun.sh) server that decodes Arkiv entity-registry transaction data back into
human-readable Arkiv operations (create / update / extend / transfer / delete / expire).

The Arkiv SDK encodes entity mutations as a call to the registry contract
(`0x4400000000000000000000000000000000000044`):

```solidity
function execute((
  uint8 operationType,
  bytes32 entityKey,
  bytes payload,
  (bytes32[4] data) contentType,            // Mime128
  (bytes32 name, uint8 valueType, bytes32[4] value)[] attributes,
  uint32 expiresAt,                          // block-denominated
  address newOwner
)[] ops) external
```

This service reverses that encoding. It accepts either bare `execute()` calldata or a full
RLP-serialized transaction (signed or unsigned, legacy/2930/1559) and returns the decoded
operations as JSON.

## Run

```sh
bun install
bun start          # listens on :3000, override with PORT=...
```

## API

### `POST /api/decode`

Body: `{"data": "0x..."}` (JSON) or the raw hex string as `text/plain`.
Also available as `GET /api/decode?data=0x...`.

```sh
curl -s localhost:3000/api/decode \
  -H 'content-type: application/json' \
  -d '{"data": "0x31708cbe..."}'
```

Response:

```json
{
  "functionName": "execute",
  "operations": [
    {
      "operationType": 1,
      "operation": "create",
      "entityKey": "0x1111...",
      "payload": { "hex": "0x48656c6c6f2041726b6976", "size": 11, "text": "Hello Arkiv" },
      "contentType": "text/plain",
      "attributes": [
        { "key": "category", "valueType": 2, "valueTypeName": "string", "value": "greeting" },
        { "key": "version", "valueType": 1, "valueTypeName": "uint", "value": "42" }
      ],
      "expiresAtBlocks": 1800,
      "approxExpiresInSeconds": 3600,
      "newOwner": null
    }
  ]
}
```

Notes:

- `payload.text` is present only when the payload is valid UTF-8.
- `approxExpiresInSeconds` assumes the 2-second Arkiv block time; the on-chain value is `expiresAtBlocks`.
- For a serialized transaction the response also includes `to`, plus a `warning` when the target
  is not the known Arkiv registry address.
- Decoding errors return `400` with `{"error": "..."}`.

### `GET /api/health`

Returns `{"status": "ok"}`.

## Development

```sh
bun test           # run the test suite
bun run typecheck  # tsc --noEmit
bun run dev        # auto-reloading server
```

CI (GitHub Actions) runs typecheck + tests on every push and pull request.
