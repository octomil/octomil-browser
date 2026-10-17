# Trust test vectors

TEST-ONLY. Every private key under `keys/` was generated for these vectors and is public.
They must never be trusted by any shipped trust root, and any SDK that finds one of these
keyids in a production trust root must refuse to start.

Regenerate with `python3 scripts/gen_trust_vectors.py` (needs the `openssl` CLI; Ed25519 is
deterministic so the output is stable). Run with `python3 ci/verify_trust_vectors.py`.

## Byte construction

- Payload bytes: RFC 8785 (JCS) canonical JSON of the payload. Payloads contain no floats.
- Signed bytes: `DSSEv1 <len(payloadType)> <payloadType> <len(payload bytes)> <payload bytes>`
  (decimal lengths, single spaces, raw payload bytes, not base64).
- Signature: raw Ed25519 (64 bytes), standard base64. Public keys: raw 32 bytes, standard base64.
- The verifier re-canonicalises the decoded payload and rejects it if the bytes differ.

## Vector format

Each file in `vectors/` is one case with an `operation` and an `expect` object. All keys in
`expect` must match the result.

| operation | inputs | result |
|---|---|---|
| `verify_manifest` | `now`, `pinned_root`, `trust_root` envelope, `state`, `context`, `manifest` envelope (null = absent) | `ok`, `warn_unverified`, or `error` + `code` |
| `accept_trust_root` | `now`, `current` roots, `candidate` envelope | `ok` or `error` + `code` |
| `resume_download` | `journal`, `current_manifest_sha256`, `manifest_chunks`, `disk`, `remote` | `ok`, `restart`, or `error` + `code`, with `discard_partial` |

`schema_invalid: true` marks vectors whose payload intentionally violates
`schemas/core/signed_manifest.json`; the verifier must still fail them with the stated code.

The order of checks is normative and lives in `policy/trust.yaml` (`verification_steps`).
Key validity is evaluated at the manifest `issued_at`; manifest and trust-root expiry at `now`.
Cache reads run the same `verify_manifest` against the current trust root.

## Keys

| keyid | role |
|---|---|
| `root-a`, `root-b`, `root-c` | pinned roots, threshold 2 |
| `root-d`, `root-e` | roots introduced by rotation vectors |
| `release-2026-a` | release key, scope both |
| `release-model-only`, `release-runtime-only` | scope mismatch vectors |
| `release-revoked` | listed in `revoked_keyids` |
| `release-old` | key window ended 2026-06-30 |
| `rogue-release`, `rogue-1`, `rogue-2` | keys the trust root does not know |
