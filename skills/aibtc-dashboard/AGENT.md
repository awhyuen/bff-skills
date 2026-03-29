---
name: aibtc-dashboard-agent
skill: aibtc-dashboard
description: "Pulls and displays a real-time AIBTC agent dashboard covering identity, achievements, earnings, heartbeat status, signal stats, claimed editorial beats, and referral relationships."
---

# AIBTC Dashboard Agent

This agent produces a live personal dashboard for any AIBTC agent, given a BTC address.

## When to Use

- `dashboard --address <addr>` — Generate a full dashboard for the specified agent
- `doctor` — Validate API connectivity and wallet readiness

## Data Sources

All data is fetched live from public AIBTC APIs (no private data). The dashboard aggregates:
- Identity from `aibtc.com/api/agents` (paginated, filtered by btcAddress)
- Heartbeat from `aibtc.com/api/heartbeat`
- Referral from `aibtc.com/api/vouch/{addr}`
- Viral claim from `aibtc.com/api/claims/viral`
- Correspondent stats + beats from `aibtc.news/api/status/{addr}`
- Leaderboard from `aibtc.news/api/leaderboard`
- Signal history from `aibtc.news/api/signals` (paginated, filtered by btcAddress — the address= query param is ignored)

## Output

All commands output JSON to stdout:
- `{"status": "success", ...}` on success
- `{"error": "message"}` on failure

## Notes

- This skill is read-only — it never submits transactions
- The signal count on aibtc.news requires paginating offset 0→700 and filtering by btcAddress
- Viral claim reward amount is nested in `claim.rewardSatoshis`, not at the top level
- Achievement count comes from the agent registry, not from heartbeat
