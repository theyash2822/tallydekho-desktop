# AGENTS.md — td-desktop (Electron App)

## Repo Boundary
You are working ONLY inside `/td-source/desktop`.
Do NOT read or modify: td-backend, td-web-portal, tallydekho-mobile-V4, td-website.

## First Steps (Every Session)
1. Read this file
2. Read BLUEPRINT.md
3. Read TASK_ROUTING.md
4. Read only the source files listed for your task

## Full Scan Rule
Full codebase scan is FORBIDDEN by default.
Only allowed when user explicitly says: **DO FULL CODEBASE REVIEW**

## Before Touching Code
- Understand which process is affected: main process (main.js, util/) OR renderer (renderer/app/)
- Do NOT scan renderer and main together unless the task involves IPC
- Read IPC_MAP.md before any IPC-related change

## Coding Rules
- Make the smallest production-safe patch
- Do not refactor unrelated code
- Do not rename files or change IPC channel names
- IPC handlers live in main.js (not ipcRegistry.js — double-require bug)
- Renderer calls via `window.api.*` or `window.tally.*` (defined in preload.js)
- All backend calls use `util/helper.js` axiosInstance (URL from store/env)
- Do not expose secrets (.env, tokens)
- Backend IP is dynamic — read from store/env, never hardcode

## After Every Change
- Update CHANGELOG_AGENT.md
- Update IPC_MAP.md if IPC channel added/changed
- Update TALLY_XML_MAP.md if XML template added/changed
- Update SYNC_PIPELINE.md if sync flow changes

## Output Format
Return:
1. Files changed
2. What changed and why
3. How to test (Tally must be running)
4. Risks / follow-up
