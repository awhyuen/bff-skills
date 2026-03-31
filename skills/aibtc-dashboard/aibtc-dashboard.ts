#!/usr/bin/env bun
/**
 * AIBTC Agent Personal Dashboard
 * CLI tool to pull live dashboard data for any AIBTC agent by BTC address.
 *
 * Usage:
 *   bun run aibtc-dashboard/aibtc-dashboard.ts dashboard --address bc1q...
 *   bun run aibtc-dashboard/aibtc-dashboard.ts doctor
 */

import { parseArgs } from "util";

const COMMON_HEADERS = { "User-Agent": "AIBTC-Dashboard/1.0", Accept: "application/json" };

// ── API helpers ────────────────────────────────────────────────────────────────

async function apiGet(url: string, timeout = 15000): Promise<any> {
  const r = await fetch(url, { headers: COMMON_HEADERS, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`API error ${r.status} on ${url}`);
  return r.json();
}

// ── Data fetchers ─────────────────────────────────────────────────────────────

interface AgentRecord {
  btcAddress: string;
  displayName: string | null;
  level: number;
  levelName: string;
  achievementCount: number;
  checkInCount: number;
  lastActiveAt: string | null;
}

async function getAgent(addr: string): Promise<AgentRecord | null> {
  for (let offset = 0; ; offset += 100) {
    const page = await apiGet(`https://aibtc.com/api/agents?limit=100&offset=${offset}`);
    const agents: AgentRecord[] = page.agents ?? [];
    const match = agents.find((a) => a.btcAddress.toLowerCase() === addr.toLowerCase());
    if (match) return match;
    if (!page.pagination?.hasMore) break;
  }
  return null;
}

interface Signal {
  btcAddress: string;
  status: string;
  timestamp: string;
  [key: string]: any;
}

async function getOurSignals(addr: string): Promise<Signal[]> {
  const results: Signal[] = [];
  // The signals API returns a global ordered list; our signals are scattered across
  // arbitrary offsets. Do NOT break on empty pages — continue scanning up to 700 total
  // to capture all signals (confirmed: signals exist at offset 650+).
  for (let offset = 0; offset < 2000; offset += 50) {
    const page = await apiGet(`https://aibtc.news/api/signals?limit=50&offset=${offset}`);
    const sigs: Signal[] = page.signals ?? [];
    if (sigs.length === 0) {
      // No more signals in the global pool
      break;
    }
    results.push(...sigs.filter((s) => s.btcAddress?.toLowerCase() === addr.toLowerCase()));
  }
  return results;
}

// ── Main logic ────────────────────────────────────────────────────────────────

const LEVEL_NAMES: Record<number, string> = { 0: "Unverified", 1: "Registered", 2: "Genesis" };

function todayUTC(): string {
  const now = new Date();
  return now.toISOString().slice(0, 10);
}

function toDateStr(ts: string | null): string {
  return ts ? ts.slice(0, 10) : "";
}

async function buildDashboard(addr: string) {
  const TODAY = todayUTC();

  // Parallel fetches
  const [agent, hb, vouch, viral, newsStatus, ldRaw] = await Promise.all([
    getAgent(addr).catch(() => null),
    apiGet(`https://aibtc.com/api/heartbeat?address=${addr}`).catch(() => ({})),
    apiGet(`https://aibtc.com/api/vouch/${addr}`).catch(() => ({})),
    apiGet(`https://aibtc.com/api/claims/viral?btcAddress=${addr}`).catch(() => ({})),
    apiGet(`https://aibtc.news/api/status/${addr}`).catch(() => ({})),
    apiGet("https://aibtc.news/api/leaderboard?limit=50").catch(() => ({})),
  ]);

  const ori: any = hb.orientation ?? {};
  const displayName = agent?.displayName ?? ori.displayName ?? "未设置";
  const levelVal = ori.level ?? agent?.level ?? 0;
  const levelName = LEVEL_NAMES[levelVal] ?? "Unknown";
  const achievements = agent?.achievementCount ?? 0;
  const checkins = ori.checkInCount ?? agent?.checkInCount ?? 0;
  const lastActive = ori.lastActiveAt ?? agent?.lastActiveAt ?? "";
  const lastActiveS = lastActive ? `${lastActive.slice(0, 19)}Z` : "N/A";
  const todayCheckedIn = toDateStr(lastActive) === TODAY;

  // Viral claim — rewardSatoshis is NESTED inside `claim`
  const viralClaim = viral as any;
  const viralClaimed = viralClaim.claimed ?? false;
  const viralRewarded = viralClaim.rewarded ?? false;
  const viralSats = viralClaim.claim?.rewardSatoshis ?? 0;

  // Referral
  const vouchedBy: any = vouch.vouchedBy ?? null;
  const referredAgents: any[] = vouch.vouchedFor?.agents ?? [];
  const remainingRef = vouch.vouchedFor?.remainingReferrals ?? "?";

  // Earnings — newsStatus.earnings is a LIST of earnings records, not a dict with a `total` field
  // Each record: { id, btcAddress, amount_sats, reason, reference_id, created_at, payout_txid, voided_at }
  const cdEarningsList: any[] = Array.isArray(newsStatus.earnings) ? newsStatus.earnings : [];
  let totalEarned = 0;
  if (Array.isArray(cdEarningsList)) {
    for (const e of cdEarningsList) {
      // Only count brief_inclusion earnings that are NOT voided
      if (e.reason === "brief_inclusion" && !e.voided_at) {
        totalEarned += e.amount_sats ?? 0;
      }
    }
  }

  // Pending
  let pendingSats = 0;
  const pendingBreakdown: any[] = [];
  if (viralClaimed && !viralRewarded && viralSats) {
    pendingSats += viralSats;
    pendingBreakdown.push({ type: "LV2 viral claim", sats: viralSats, status: "⏳ pending" });
  }
  for (const ref of referredAgents) {
    pendingSats += 50000;
    pendingBreakdown.push({ type: `referred: ${ref.displayName ?? ref.btcAddress?.slice(0, 20)}`, sats: 50000, status: "⏳ 5-day activation" });
  }
  if (vouchedBy) {
    pendingSats += 50000;
    pendingBreakdown.push({ type: `referred by ${vouchedBy.displayName ?? ""}`, sats: 50000, status: "⏳ 5-day activation" });
  }

  // Add brief_inclusion earnings to pending (these are signal rewards, 30000 sats each)
  if (Array.isArray(cdEarningsList)) {
    for (const e of cdEarningsList) {
      if (e.reason === "brief_inclusion" && !e.voided_at) {
        pendingSats += e.amount_sats ?? 0;
        const refShort = (e.reference_id ?? "?").slice(0, 8);
        pendingBreakdown.push({ type: `signal ${refShort}...`, sats: e.amount_sats ?? 0, status: "⏳ pending" });
      }
    }
  }

  // Signals — scan ALL signals via full pagination, then derive per-status counts.
  // Do NOT break on empty pages (signals are scattered across arbitrary global offsets).
  // Pagination must reach offset ~850+ to capture all our signals (confirmed: signals at 850).
  const allSigs = await getOurSignals(addr);

  // totalSignals and signalsToday come from /api/status/{addr} — authoritative counts
  const totalSignals = newsStatus.totalSignals ?? allSigs.length;
  const signalsToday = newsStatus.signalsToday ?? 0;
  const weekStart = Date.now() / 1000 - 7 * 86400;
  const weekSigs = allSigs.filter((s) => {
    if (!s.timestamp) return false;
    return new Date(s.timestamp).getTime() / 1000 >= weekStart;
  });

  // Derive per-status counts from the complete scanned set
  const approved = allSigs.filter((s) => s.status === "approved");
  const briefIncl = allSigs.filter((s) => s.status === "brief_included");
  const rejected = allSigs.filter((s) => s.status === "rejected" || s.status === "feedback");
  const inReview = allSigs.filter((s) => s.status === "in_review" || s.status === "submitted");

  // Leaderboard
  const ourLd: any = (ldRaw.leaderboard ?? []).find(
    (e: any) => e.address?.toLowerCase() === addr.toLowerCase()
  );
  const lbScore = ourLd?.score ?? newsStatus.score ?? "?";
  const lbBreakdown = ourLd?.breakdown ?? {};

  // Beats
  let beatsClaimed: string[] = newsStatus.beatsClaimed ?? [];
  if (!beatsClaimed.length && ourLd?.beats) {
    beatsClaimed = ourLd.beats.map((b: any) => b.id ?? b.name ?? "?");
  }

  // Referral display
  const referral: any = { remainingReferrals: remainingRef };
  if (vouchedBy) referral.vouchedBy = { displayName: vouchedBy.displayName };
  if (referredAgents.length) referral.referredAgents = referredAgents.map((r: any) => ({ displayName: r.displayName }));

  return {
    status: "success",
    address: addr,
    data: {
      displayName,
      level: levelVal,
      levelName,
      achievementCount: achievements,
      checkInCount: checkins,
      lastActiveAt: lastActiveS,
      todayCheckedIn,
      totalEarned,
      pendingSats,
      pendingBreakdown,
      viralClaim: { claimed: viralClaimed, rewarded: viralRewarded, sats: viralSats },
      signals: {
        total: totalSignals,
        approved: approved.length,
        briefIncluded: briefIncl.length,
        rejected: rejected.length,
        inReview: inReview.length,
        today: signalsToday,
        thisWeek: weekSigs.length,
      },
      leaderboard: { score: lbScore, breakdown: lbBreakdown },
      beatsClaimed,
      referral,
    },
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    address: { type: "string", short: "a" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

const cmd = positionals[0];

async function main() {
  if (!cmd || values.help) {
    console.log(`Usage:
  bun run aibtc-dashboard/aibtc-dashboard.ts dashboard --address <bc1q...>
  bun run aibtc-dashboard/aibtc-dashboard.ts doctor
Options:
  --address, -a  BTC address (bc1q... or bc1p...)`);
    process.exit(0);
  }

  if (cmd === "doctor") {
    const endpoints = [
      "https://aibtc.com/api/agents?limit=1",
      "https://aibtc.com/api/heartbeat?address=bc1q3wcjxn2wqk2sl2jv8vtnvhcnjkx8uare82296x",
      "https://aibtc.news/api/status/bc1q3wcjxn2wqk2sl2jv8vtnvhcnjkx8uare82296x",
    ];
    const results: any[] = [];
    for (const url of endpoints) {
      try {
        await apiGet(url);
        results.push({ url, status: "ok" });
      } catch (e: any) {
        results.push({ url, status: "error", message: e.message });
      }
    }
    console.log(JSON.stringify({ status: "success", results }, null, 2));
    return;
  }

  if (cmd === "dashboard") {
    const addr = values.address;
    if (!addr || !addr.startsWith("bc1")) {
      console.error(JSON.stringify({ error: "A valid BTC address (bc1q... or bc1p...) is required. Use --address <addr>" }));
      process.exit(1);
    }
    try {
      const result = await buildDashboard(addr);
      console.log(JSON.stringify(result, null, 2));
    } catch (e: any) {
      console.error(JSON.stringify({ error: e.message }));
      process.exit(1);
    }
    return;
  }

  console.error(JSON.stringify({ error: `Unknown command: ${cmd}. Use "dashboard" or "doctor".` }));
  process.exit(1);
}

main();
