# nutrition-bot

Two Telegram bots in one Vercel project, sharing a Supabase database.

| | Old bot | New agent |
|---|---|---|
| Entry point | `api/telegram.js` | `api/agent.js` |
| Brain | hand-written flows, `lib/claude.js` | Claude agent loop, `lib/agent-core.js` |
| Status | **in daily use — do not touch** | on trial, running in parallel |

The agent replaces the old bot only after ~1 week of parallel logging proves it.
Until Ron says otherwise, **never edit `api/telegram.js` or `lib/claude.js`**.

## Layout

```
api/agent.js         webhook + all presentation + the code-first pipeline
lib/parser.js        deterministic Hebrew meal/correction/measurement parsing — no LLM
lib/barcode.js       barcode decoding from photos (zxing-wasm) — no LLM
lib/agent-core.js    context building, system prompts (full + lite), tools, agent loop, undo
lib/charts.js        QuickChart configs — only aggregates leave the process
lib/db.js            shared with the old bot
schema-agent.sql     accumulated DDL for the agent's tables
test/                179 tests, no network
```

## Architecture: code-first (since 2026-08-26)

Claude is NOT in the default path. Every message runs through code:
commands/buttons → barcode digits → label-questionnaire reply → correction
templates → measurement template → the meal parser (dictionary + fuzzy) →
Israeli-DB suggestion buttons. Anything unresolved gets a "לא זיהיתי" message
with buttons — and the AI runs **only** when the user taps 🤖.

The 🤖 button runs a **lite agent**: `AGENT_LITE_MODEL` (default
`claude-sonnet-5` — Haiku was tried live on 2026-08-26 and rejected: clunky
Hebrew, clarification loops, invented restaurant values), a ~⅕-size system
prompt (`buildSystemLite`), 4 tools + web search for brand/restaurant values
(the web tool is gated off if the env overrides back to Haiku — its variant
400s there). A hard monthly budget (`AGENT_AI_BUDGET_ILS`, default ₪1) is
enforced in code from the `agent_usage` table; over budget, the button offers
an explicit override. An open lite-AI question is marked 🤖 in the chat log
and owns the next messages (10-minute window) so answers return to the AI.

**Rollback switch:** `AGENT_MODE=agent` (env var in Vercel) restores the old
everything-through-Claude behavior. The test harness pins this mode for the
legacy suites; `test/codefirst.test.js` tests the production default.

The parser's iron rule: never guess. Every layer either resolves with full
confidence or declines to the next one. Prompt caching was evaluated and
dropped: the lite prompt is smaller than Haiku's 4096-token cacheable minimum,
and the default path uses no LLM at all.

## Hard rules

**Ron runs all SQL himself.** Never attempt DDL. Write the statement into
`schema-agent.sql`, show it in chat, and let him paste it into the Supabase SQL
Editor. There is no connection string and no Management API token in this repo,
by decision — PostgREST with the service_role key can do data but not schema.

**One feature per deploy.** Build it, run the tests, push, and stop for Ron to
test in Telegram before starting the next thing. Batched uploads caused
truncated-file 500s on a previous project.

**`npm test` before every push.** The suite runs the real webhook and agent code
against an in-memory Supabase fake with scripted Claude responses. It has caught
five bugs that manual testing could not reach. A bug fix without a test that
fails on the pre-fix code is not finished.

**Visual formatting is a product requirement, not a preference.** Ron reads
visually and struggles with walls of text. Every message the bot sends — the
model's own answers included — follows prompt rule 8ב: one idea per line, the
deciding number first and bold, a blank line between groups, secondary detail
inside `<blockquote expandable>`, a fixed emoji vocabulary.

**RTL: never put a slash between two numbers.** `1,252 / 2,100` renders
reversed in Hebrew. Write `1,252 מתוך 2,100`.

## Model

Full agent: `claude-sonnet-5` (override `AGENT_MODEL`) — only used when
`AGENT_MODE=agent`. Lite agent (the 🤖 button): `claude-sonnet-5` (override
`AGENT_LITE_MODEL`). **Do not send `temperature`** — sampling parameters are
rejected with a 400 on Sonnet 5.

Vercel Hobby caps functions at 60s, so `api/agent.js` sets `maxDuration: 60` and
the loop budgets itself: `MAX_ROUNDS` tool rounds, `MAX_PAUSES` web-search
continuations, `DEADLINE_MS` wall clock.

## Food resolution cascade

Prompt rule 3ב, in order, no skipping and no reordering:

1. `my_foods` — the personal dictionary
2. barcode / label photo
3. `lookup_israeli_food` — Tzameret, the MoH national database via data.gov.il
   CKAN. Free, no key, Hebrew, ~4,500 foods and ~19k household measures.
   **The join key is `Code`, not `smlmitzrach`.** ~2s per lookup.
4. `web_search` — branded products and restaurant dishes only
5. the model's own estimate, last resort, biased to the high end

Every item stores a macro snapshot plus `source_type` and `quantity_source`, so
the accuracy percentage is computed from real provenance rather than guessed.

FatSecret was evaluated and rejected: the free tier is US-only and it requires
IP whitelisting, which Vercel Hobby's dynamic egress cannot provide. Open Food
Facts has thin Israeli coverage (1 of 6 barcodes tested) — a miss asks for a
label photo once and saves the barcode into `my_foods`.

## Deploy

Push to `main`; Vercel deploys automatically. Ron has pre-approved pushes for
work he asked for. Nothing else about the deployment is automated — there is no
Vercel CLI login in this environment, so **runtime logs are not readable from a
session.** That is why failures must report their own cause to the user.

## Known state

Phase 1 and phase 2 are built: logging, corrections, deletion, the personal
dictionary with auto-learning, measurements with the Navy body-fat formula
computed in code, goals, questions over history, photos, barcodes, recipes,
saved meals, the Israeli database, web search, charts, and a persistent keyboard.

Open, not started: fitness logging (strength training in the bot; Apple Health
via an iOS Shortcuts automation POSTing to a new endpoint — HealthKit has no
server API, and workouts carry no per-set weights, so lifts belong in the bot).

Open question Ron has not answered: which decisions the fitness data should
drive. Do not build the data model before that is settled.
