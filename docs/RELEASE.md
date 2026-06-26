# Release checklist

> The default `npm test` gate is fast but **mocks `foundry.call`** — it proves Node-side arg shaping and
> the pure page-side logic, **not** that the code which mutates the live Foundry DB actually works. The
> live integration suite is the gate for that, and it is **off by default**. Before tagging a release, run
> it against a live Molten world so a green tag means the write paths were exercised end-to-end.

## Before every release tag

1. **Full offline gate green** (must already pass on `master`):
   ```sh
   npm run check        # biome
   npm run typecheck    # tsc --noEmit
   npm test             # vitest (unit)
   npm run build        # tsc + esbuild page bundle
   npm run knip
   ```

2. **Live integration suite green** — needs a live Molten box and a populated `.env`
   (`MOLTEN_SERVER_URL`, `MOLTEN_MAGIC_URL`, `FOUNDRY_USER`, and `MOLTEN_ADMIN_KEY` + `MOLTEN_WORLD_ID`
   for a cold-box launch). This runs `npm run build` first, then the suites that page-eval-inspect the
   real data model:
   ```sh
   RUN_LIVE=1 npm run test:integration
   ```
   Confirm these suites actually ran (not skipped) and passed:
   - `tests/integration/pc.int.test.ts` — PC build + advancement (HP, spell slots, multiclass, subclass,
     **zero unresolved @scale**).
   - `tests/integration/dnd5e-writes.int.test.ts` — NPC authoring + activity/save/spell data model.
   - `tests/integration/write-cycle.int.test.ts`, `reads.int.test.ts`, `chat.int.test.ts` — CRUD round-trips.

   > A green `npm run test:integration` with **no** `RUN_LIVE` only reports skips — that does **not**
   > satisfy this step. Verify the run output shows the live suites executing.

3. **Smoke the headline tools over MCP** (after a Claude Code restart, which is required to pick up changed
   tool behavior): build a multiclass-L3 PC (expect `success` + zero unresolved @scale) and confirm a
   deliberately bad subclass uuid returns `success:false` + `errors[]` with no actor created.

4. Bump `version` in `package.json`, update any changelog, tag, and push.
