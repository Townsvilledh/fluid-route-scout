// Fluid Route Scout — a personal agent that lives on a Fly.io Sprite.
//
// Built for Fly.io Hacksgiving 2026 by Ethuram (Townsville), with Muse.
// AI tools are explicitly allowed by the Hacksgiving rules; this file was
// written by an AI assistant and is labelled as such everywhere it matters.
//
// What the agent does:
//   - Watches a small set of cross-chain swap pairs that Fluid routes
//     (pairs no single exchange or bridge lists on its own).
//   - Every cycle it pulls LIVE dry quotes from the 1Click API — the same
//     public quote rail Lubrica (Fluid's routing plug) composes through.
//     Dry quotes only: nothing is deposited, signed or executed, ever.
//   - It keeps its quote history on the Sprite's persistent disk, spots
//     rate moves between cycles, and writes a short plain-English briefing.
//     When the Sprites OpenRouter connector is configured, the briefing is
//     written by an LLM reached through the Sprites gateway — the Sprite
//     itself never holds an API key (that is the whole point of Sprites
//     connectors). Without it, the agent falls back to a template briefing
//     built from the same numbers.
//   - It serves a public dashboard + JSON API on the Sprite's own URL.
//
// Non-custodial and read-only by design: this agent can look, but it cannot
// touch funds. It holds no keys, signs nothing, and moves nothing.

import http from "node:http";
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = path.join(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const HISTORY_FILE = path.join(DATA_DIR, "history.jsonl");
const BRIEFING_FILE = path.join(DATA_DIR, "briefing.md");
const CYCLE_MINUTES = Number(process.env.WATCH_INTERVAL_MIN || 30);

const ONECLICK = "https://1click.chaindefuser.com/v0/quote";

// Dry-run form addresses: quotes are requested with dry:true, so nothing is
// ever deposited to or refunded from these. They only need to be
// syntactically valid for the destination/origin chain so the quote API
// will price the route. The Sui recipient is the 0x…02 system address.
const SUI_RECIPIENT =
  "0x0000000000000000000000000000000000000000000000000000000000000002";
const REFUND = {
  btc: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
  bch: "qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a",
  xrp: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
  stellar: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
  doge: "DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L",
};

// The watchlist: cross-family pairs Fluid composes a route for. Amounts are
// human units; base units are derived from each asset's decimals.
const ASSETS = {
  BTC: { assetId: "nep141:btc.omft.near", decimals: 8, chain: "btc" },
  BCH: { assetId: "nep141:bch.omft.near", decimals: 8, chain: "bch" },
  XRP: { assetId: "nep141:xrp.omft.near", decimals: 6, chain: "xrp" },
  XLM: {
    assetId: "nep245:v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz",
    decimals: 7,
    chain: "stellar",
    depositMode: "MEMO", // Stellar deposits ride a shared account + memo
  },
  DOGE: { assetId: "nep141:doge.omft.near", decimals: 8, chain: "doge" },
  SUI: { assetId: "nep141:sui.omft.near", decimals: 9, chain: "sui" },
};
const WATCHLIST = [
  { from: "BCH", to: "SUI", amount: "0.05" },
  { from: "XRP", to: "SUI", amount: "12" },
  { from: "XLM", to: "SUI", amount: "100" },
  { from: "DOGE", to: "SUI", amount: "500" },
  { from: "BTC", to: "SUI", amount: "0.0002" },
];

function toBaseUnits(amountHuman, decimals) {
  const [whole, frac = ""] = String(amountHuman).split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return (whole + fracPadded).replace(/^0+(?=\d)/, "");
}

async function dryQuote(pair) {
  const origin = ASSETS[pair.from];
  const dest = ASSETS[pair.to];
  const body = {
    dry: true,
    ...(origin.depositMode ? { depositMode: origin.depositMode } : {}),
    depositType: "ORIGIN_CHAIN",
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: origin.assetId,
    destinationAsset: dest.assetId,
    amount: toBaseUnits(pair.amount, origin.decimals),
    refundTo: REFUND[origin.chain],
    refundType: "ORIGIN_CHAIN",
    recipient: SUI_RECIPIENT,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    referral: "fluid",
  };
  const res = await fetch(ONECLICK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.quote) {
    throw new Error(`1Click quote failed (${res.status}): ${data.message || "unknown"}`);
  }
  const q = data.quote;
  return {
    pair: `${pair.from}->${pair.to}`,
    from: pair.from,
    to: pair.to,
    amountIn: q.amountInFormatted,
    amountInUsd: q.amountInUsd,
    amountOut: q.amountOutFormatted,
    amountOutUsd: q.amountOutUsd,
    timeEstimateSeconds: q.timeEstimate,
    quotedAt: new Date().toISOString(),
  };
}

// ---- Briefing -------------------------------------------------------------
// If SPRITES_GATEWAY_URL is set (the OpenRouter connector gateway base,
// copied from the Fly.io dashboard — it already contains the provider and
// connection id), the briefing is written by an LLM through the connector.
// The gateway attaches the real credential; the Sprite sends a placeholder.
async function llmBriefing(rows, moves) {
  const base = process.env.SPRITES_GATEWAY_URL;
  if (!base) return null;
  const model = process.env.LLM_MODEL || "openai/gpt-4o-mini";
  const llmPath = process.env.SPRITES_LLM_PATH || "/api/v1/chat/completions";
  const prompt =
    `You are Fluid Route Scout, a personal agent living on a Fly.io Sprite. ` +
    `Write a briefing of at most 5 short sentences, plain English, no hype, no invented numbers, ` +
    `from this live dry-quote data (JSON): ${JSON.stringify(rows)}. ` +
    `Rate moves since the previous cycle: ${JSON.stringify(moves)}. ` +
    `Say which route currently gives the most out per dollar in, and flag any move over 1%. ` +
    `These are quotes only — nothing was bought or sold.`;
  const res = await fetch(`${base.replace(/\/$/, "")}${llmPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer sprites-connector", // placeholder — gateway adds the real key
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 220,
    }),
  });
  if (!res.ok) throw new Error(`LLM gateway ${res.status}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("LLM returned no text");
  return text;
}

function templateBriefing(rows, moves) {
  const lines = [];
  lines.push(`Route Scout briefing — ${new Date().toUTCString()}`);
  const ok = rows.filter((r) => !r.error);
  if (!ok.length) {
    lines.push("No live quotes came back this cycle. The rails may be having a moment; I will try again next cycle.");
    return lines.join("\n");
  }
  const best = ok.reduce((a, b) =>
    Number(b.amountOutUsd) / Number(b.amountInUsd) > Number(a.amountOutUsd) / Number(a.amountInUsd) ? b : a
  );
  lines.push(
    `Best value this cycle: ${best.pair} — ${best.amountIn} ${best.from} in (~$${Number(best.amountInUsd).toFixed(2)}) ` +
      `quotes ${best.amountOut} ${best.to} out (~$${Number(best.amountOutUsd).toFixed(2)}), ~${best.timeEstimateSeconds}s delivery estimate.`
  );
  const big = moves.filter((m) => Math.abs(m.changePct) >= 1);
  if (big.length) {
    for (const m of big)
      lines.push(`Move: ${m.pair} output ${m.changePct > 0 ? "up" : "down"} ${Math.abs(m.changePct).toFixed(2)}% since last cycle.`);
  } else {
    lines.push("No route moved 1% or more since the last cycle.");
  }
  lines.push("Quotes are live dry quotes via the 1Click rail — information only, nothing executed.");
  return lines.join("\n");
}

// ---- Agent cycle ----------------------------------------------------------
let state = { cycles: 0, latest: [], lastRunAt: null, briefing: "" };

async function loadState() {
  try {
    if (existsSync(STATE_FILE)) state = JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    /* start fresh */
  }
}

async function runCycle() {
  const prev = new Map(state.latest.filter((r) => !r.error).map((r) => [r.pair, r]));
  const rows = [];
  for (const pair of WATCHLIST) {
    try {
      rows.push(await dryQuote(pair));
    } catch (e) {
      rows.push({ pair: `${pair.from}->${pair.to}`, from: pair.from, to: pair.to, error: String(e.message || e) });
    }
  }
  const moves = [];
  for (const r of rows) {
    if (r.error || !prev.has(r.pair)) continue;
    const before = Number(prev.get(r.pair).amountOut);
    const now = Number(r.amountOut);
    if (before > 0) moves.push({ pair: r.pair, changePct: ((now - before) / before) * 100 });
  }
  let briefing;
  let briefingSource = "template";
  try {
    briefing = await llmBriefing(rows, moves);
    if (briefing) briefingSource = "llm-via-sprites-connector";
  } catch {
    briefing = null;
  }
  if (!briefing) briefing = templateBriefing(rows, moves);

  state = {
    cycles: state.cycles + 1,
    latest: rows,
    lastRunAt: new Date().toISOString(),
    briefing,
    briefingSource,
  };
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  await writeFile(BRIEFING_FILE, briefing + "\n");
  await appendFile(HISTORY_FILE, JSON.stringify({ at: state.lastRunAt, rows }) + "\n");
  console.log(`[route-scout] cycle ${state.cycles} done — ${rows.filter((r) => !r.error).length}/${rows.length} quotes ok, briefing: ${briefingSource}`);
}

// ---- HTTP surface ---------------------------------------------------------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function landingPage() {
  const rows = state.latest
    .map((r) =>
      r.error
        ? `<tr><td>${esc(r.pair)}</td><td colspan="4">couldn't load this cycle — ${esc(r.error)}</td></tr>`
        : `<tr><td><strong>${esc(r.from)} → ${esc(r.to)}</strong></td><td>${esc(r.amountIn)} ${esc(r.from)} (~$${esc(Number(r.amountInUsd).toFixed(2))})</td><td>${esc(r.amountOut)} ${esc(r.to)} (~$${esc(Number(r.amountOutUsd).toFixed(2))})</td><td>~${esc(r.timeEstimateSeconds)}s</td><td>${esc(new Date(r.quotedAt).toUTCString())}</td></tr>`
    )
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fluid Route Scout — a personal agent on a Fly.io Sprite</title>
<style>body{background:#000;color:#f5f5f5;font-family:system-ui,sans-serif;max-width:880px;margin:0 auto;padding:24px;line-height:1.55}
h1{color:#f7931a} a{color:#f7931a} table{border-collapse:collapse;width:100%;margin:16px 0} td,th{border:1px solid #333;padding:8px;text-align:left}
pre{background:#111;padding:16px;white-space:pre-wrap;border:1px solid #333} .muted{color:#aaa}</style></head>
<body>
<h1>Fluid Route Scout</h1>
<p>A personal agent that lives on a <strong>Fly.io Sprite</strong>, built for Hacksgiving 2026 by
Ethuram (Townsville) with Muse. It watches the cross-chain routes Fluid composes — pairs no single
exchange or bridge lists — and reports what they pay, live.</p>
<p><strong>Fluid</strong> is a free, open-source, non-custodial wallet: one seed phrase, every blockchain,
no account, no KYC, no minimums. <strong>Lubrica</strong> is its routing plug — an aggregator that composes
a route across rails when no single rail serves a pair. This agent watches those routes through the
<strong>1Click</strong> quote rail and keeps its history on the Sprite's persistent disk.</p>
<p>Every ${CYCLE_MINUTES} minutes the agent pulls fresh <em>dry</em> quotes (nothing is deposited, signed or
executed — it can look, never touch), compares them with the last cycle, and writes the briefing below.
On the Sprite, the briefing is written by an LLM reached through the <strong>Sprites OpenRouter
connector</strong> — the credential lives in the connector, never inside this machine.</p>
<h2>Latest live quotes</h2>
<table><tr><th>Pair</th><th>In</th><th>Out</th><th>Est. time</th><th>Quoted at</th></tr>
${rows || '<tr><td colspan="5">First cycle has not completed yet.</td></tr>'}
</table>
<p class="muted">Cycle ${state.cycles} · last run ${esc(state.lastRunAt || "—")} · briefing source: ${esc(state.briefingSource || "—")}</p>
<h2>Latest briefing</h2>
<pre>${esc(state.briefing || "No briefing yet.")}</pre>
<h2>Use it</h2>
<p><code>GET /quote?from=BCH&amp;to=SUI&amp;amount=0.05</code> — one live dry quote as JSON.<br>
<code>GET /api/status</code> — the agent's current state as JSON.<br>
<code>GET /briefing</code> — the latest briefing as plain text.</p>
<p class="muted">Read-only and non-custodial: this agent holds no keys and moves no funds. Quotes are
information, not financial advice. Fluid: <a href="https://fluidwallet.dpdns.org">fluidwallet.dpdns.org</a></p>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(landingPage());
    }
    if (url.pathname === "/api/status") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ agent: "fluid-route-scout", ...state }, null, 2));
    }
    if (url.pathname === "/briefing") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end(state.briefing || "No briefing yet.\n");
    }
    if (url.pathname === "/quote") {
      const from = (url.searchParams.get("from") || "").toUpperCase();
      const to = (url.searchParams.get("to") || "").toUpperCase();
      const amount = url.searchParams.get("amount") || "0.05";
      if (!ASSETS[from] || !ASSETS[to] || from === to) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "unsupported pair", supported: Object.keys(ASSETS) }));
      }
      const q = await dryQuote({ from, to, amount });
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ service: "fluid-route-scout", dry: true, ...q }, null, 2));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  } catch (e) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
});

await loadState();
server.listen(PORT, () => console.log(`[route-scout] listening on :${PORT}`));
await runCycle();
setInterval(runCycle, CYCLE_MINUTES * 60 * 1000);
