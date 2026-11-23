# Fluid Route Scout

A personal agent that lives on a **Fly.io Sprite**, built for **Fly.io Hacksgiving 2026**
by **Ethuram (Townsville)** with **Muse**. Hacksgiving's rules say "use any AI tools you
like" — this project was built with an AI assistant and says so plainly.

## What it does

Fluid is a free, open-source, non-custodial wallet — one seed phrase, every blockchain,
no account, no KYC, no minimums. **Lubrica** is Fluid's routing plug: an aggregator that
composes a route across rails when no single exchange or bridge lists a pair.

Route Scout is the watchman for those routes:

1. Every 30 minutes it pulls **live dry quotes** from the public **1Click** quote API —
   the same rail Lubrica composes through — for a watchlist of cross-family pairs
   (BCH→SUI, XRP→SUI, XLM→SUI, DOGE→SUI, BTC→SUI).
2. It keeps its quote history on the Sprite's **persistent disk** (`data/history.jsonl`),
   so it remembers yesterday's rates, not just this minute's.
3. It compares each cycle with the last, flags moves ≥1%, and writes a short
   plain-English **briefing**. On the Sprite, the briefing is written by an LLM reached
   through the **Sprites OpenRouter connector** — the credential lives in the connector,
   and the Sprite only ever sends a placeholder. That is the Sprites security model
   working as intended: the agent can think without holding a key.
4. It serves a public dashboard and JSON API on the Sprite's own URL.

**Read-only by design.** Quotes are requested with `dry: true`. The agent holds no keys,
signs nothing, deposits nothing and executes nothing. It can look — never touch.

## Endpoints

| Route | What |
|---|---|
| `/` | Dashboard: explainer, latest quotes table, latest briefing |
| `/quote?from=BCH&to=SUI&amount=0.05` | One live dry quote as JSON |
| `/api/status` | Current agent state (latest cycle, briefing, source) |
| `/briefing` | Latest briefing as plain text |

## Hacksgiving checklist

- ✅ Runs on a Fly.io **Sprite** (a persistent Linux computer) — see `SPRITE-SETUP.md`
- ✅ Uses at least one **Sprites connector**: the **OpenRouter managed connector**
  (LLM briefings through the Sprites gateway; no key inside the Sprite)
- ✅ Built during Hacksgiving week (23–29 Nov 2026)
- ✅ AI tools used and disclosed

## Run it locally

```bash
node agent.js          # Node 18+, zero dependencies
# open http://localhost:8080
```

Environment variables:

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `WATCH_INTERVAL_MIN` | `30` | Minutes between quote cycles |
| `SPRITES_GATEWAY_URL` | — | OpenRouter connector gateway base from the Fly.io dashboard (includes provider + connection id). When set, briefings are written by the LLM through the connector. |
| `LLM_MODEL` | `openai/gpt-4o-mini` | Model requested through the connector |

Without `SPRITES_GATEWAY_URL` the agent still runs fully — briefings fall back to a
template built from the same live numbers, and the dashboard labels the source honestly.

## Deploy on a Sprite

Full step-by-step (account, connector, Sprite, service, verification) is in
[`SPRITE-SETUP.md`](SPRITE-SETUP.md).

## Honesty notes

- Quotes are live at fetch time from 1Click's public API; they are information, not a
  promise of execution price, and not financial advice.
- The pair watchlist amounts are small reference notionals (~$10), chosen so the quotes
  are comparable cycle to cycle.
- Prize payment terms for Hacksgiving were not published on the event page as of
  23 Nov 2026; the entry was made anyway, with eyes open.
