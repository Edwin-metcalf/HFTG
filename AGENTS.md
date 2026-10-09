# AGENTS.md

HFTG: a Vite + TypeScript canvas game about building a high-frequency trading network. No framework, no tests, no linter — raw DOM/canvas.

## Commands

- `npm run dev` — Vite dev server.
- `npm run build` — runs `tsc && vite build`. **This is the only typecheck/lint/verification step.** There is no standalone `test` or `lint` script.
- Run `npx tsc` alone for a fast typecheck without bundling.

Typecheck is strict: `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`. Pre-existing `tsc` errors on `main` (`gameManager.ts` unused `frameCount`, `main.ts` unused `renderer`) mean `npm run build` fails before any of your changes — don't assume you broke it.

## Architecture

- `src/main.ts` — entrypoint. Builds the DOM, wires canvas mouse events, owns the init sequence.
- `src/renderer.ts` — game loop. Drives `requestAnimationFrame`, clears the canvas, then dispatches a `tick` `CustomEvent` on the canvas.
- `src/gameManager.ts` — orchestration/state machine (`GameState`) and spawn logic. This is where new gameplay logic belongs.
- `src/network/` — simulation domain: `nodes.ts`, `links.ts`, `packets.ts`.
- `src/player.ts` — `Firm`, the player's money/reputation/research state.

Non-obvious loop flow: `Renderer.tick()` clears the canvas **then** dispatches `tick`; `main.ts` listens for `tick` on the canvas and calls `gameManager.update(frameCount)`. Nothing calls `update` directly. Each `Link` redraws itself in `update()`, so rendering happens inside the tick handler, not the Renderer.

## Conventions / gotchas

- Imports are inconsistent about `.ts` extensions (`player.ts` uses `./network/nodes.ts`, others omit). Both work under bundler resolution — match the surrounding file.
- Use `import type` for type-only imports (`verbatimModuleSyntax` enforces this).
- Node `id`s are random and not guaranteed unique — a known TODO, not a bug to rely on.
- Canvas is fixed at 1920x1080 (`index.html`); mouse coords are scaled from CSS size in `main.ts:getCanvasPos`.
- `GameState` enum values are SCREAMING_CASE strings and are sometimes compared against raw string literals (e.g. `"PLACINGFIRM"` in `main.ts`).
