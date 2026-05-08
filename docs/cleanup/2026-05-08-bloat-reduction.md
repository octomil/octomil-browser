# Browser SDK Bloat Reduction Track

Reviewer: @tai

## Goal

Reduce browser SDK package bloat and make generated contracts, dist output, examples, and optional local runtime dependencies trustworthy.

## Findings

- Published package includes only `dist`, but `dist/_generated` is missing generated source files and contains stale runtime engine files.
- Generated contract metadata and manifest versions do not match the current contract.
- Browser runtime planner generated types differ materially from Node.
- `@huggingface/transformers` is a direct dependency even though it is dynamically imported, and it pulls heavy runtime dependencies into browser installs.
- Source maps and stale bundled artifacts dominate package dry-run size.
- `pnpm lint` is exposed but not backed by a working eslint setup.
- The sentiment demo uses `workspace:*` without a workspace file, so documented install steps fail.

## Proposed Cleanup

- Regenerate browser contract types from the current contract and rebuild `dist` from source.
- Add a dist/source parity check and `npm pack --dry-run` check before publish.
- Move local transformers support behind an optional peer or separate package if feasible.
- Align shared client logic with the Node SDK where behavior should be common.
- Fix or remove the broken lint script.
- Add a workspace file or adjust demo dependency instructions.

## Validation

```bash
pnpm run typecheck
pnpm test
pnpm run build
pnpm run exports:check
pnpm run lint
pnpm why @huggingface/transformers
pnpm why onnxruntime-node
npm pack --dry-run --json
```
