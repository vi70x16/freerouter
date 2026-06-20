# Provider Health Heartbeat — Requirements

## 1. Problem Statement

When a provider goes down between user requests, the **first** user request that hits the dead provider always wastes retry attempts before discovering the outage. The degradation engine only penalizes models *after* real user requests fail — it has no proactive signal.

In the observed incident ("bluesminds"), the provider was fully down for an unknown duration before a user request arrived and burned 30+ attempts discovering what a single health check would have revealed in <2 seconds.

The **provider-health heartbeat** solves a different problem than the provider-outage fast-fail:

| Feature | When it helps | Scope |
|---|---|---|
| **Fast-fail** (sibling spec) | *During* a request — stops burning attempts once outage is detected | Reactive, within-request |
| **Heartbeat** (this spec) | *Before* a request — discovers outages proactively so the bandit scorer already knows | Proactive, cross-request |

**Combined effect**: If the heartbeat detects bluesminds is down at minute 10, the first real user request at minute 25 routes to a healthy provider *first* — the fast-fail may never need to fire.

### Root Cause

The degradation engine (`degradation.ts`) only records failures when real user requests fail. Between requests, it has no signal. A provider can be down for hours, and the first request after the outage pays the full discovery cost.

### Why Existing Mechanisms Don't Solve This

| Mechanism | Why it doesn't help |
|---|---|
| **degradation.ts** | Reactive only — records failures from real requests, not proactive checks |
| **Health checker** (validateKey) | Checks key *validity* (auth/balance), not model availability. A key can be valid while the model's upstream channel pool is exhausted |
| **Cooldowns** | Set *after* a real request fails. No proactive cooldown from background checks |
| **Fast-fail** (sibling spec) | Within-request only — doesn't help the *first* request that hits a cold outage |

---

## 2. User Stories

### US-1: Proactive Outage Detection
**As an operator**, I want the system to periodically ping each provider so outages are discovered before user requests hit them, reducing first-request failure cost.

### US-2: Activity-Gated Pinging
**As an operator**, I want pings to stop when no user has made a request recently (e.g., overnight), so I don't waste tokens or provider capacity on warming a system nobody is using.

### US-3: Degradation Integration
**As an operator**, I want ping results to feed the existing degradation engine, so the bandit scorer automatically ranks healthy providers above unhealthy ones — no new routing logic needed.

### US-4: Zero Interference with Real Requests
**As a user**, health-check pings must never consume my rate-limit budget (RPM/RPD/TPM/TPD), appear in my request logs, or interfere with real request routing.

### US-5: Minimal Provider Load
**As an operator**, I want one ping per provider per cycle (not one per model), so I don't consume upstream channel capacity on aggregator providers like bluesminds where each ping costs a channel slot.

### US-6: Observable
**As an operator**, I want to see ping results in the live-event stream, so I can monitor provider health between real requests.

### US-7: Configurable
**As an operator**, I want to control the ping interval, the activity-gate window, and the ability to disable the feature entirely via environment variables.

### US-8: No Ping Storms
**As an operator**, I want pings to be staggered across providers, so a single cycle doesn't fire N simultaneous requests to different providers at the same instant.

---

## 3. Functional Requirements

### FR-1: Heartbeat Timer
A module-level `setInterval` shall fire every `HEARTBEAT_INTERVAL_MIN` minutes (default: 10). Each cycle:
1. Check the activity gate (FR-2). If gated, skip the entire cycle.
2. Query all distinct enabled platforms from the fallback chain.
3. For each platform, pick one representative model and one healthy key.
4. Send a minimal non-streaming chat completion (`"hi"`, `max_tokens: 5`).
5. Record the result via the degradation engine (`recordSuccess` or `recordFailure`).

### FR-2: Activity Gate
Before each cycle, check the timestamp of the most recent real user request (recorded by `proxy.ts` on every successful or failed `/chat/completions` call). If `now - lastActivityAt > HEARTBEAT_ACTIVITY_WINDOW_MIN` (default: 15 minutes), skip the cycle entirely. This prevents pinging overnight or during idle periods.

### FR-3: One Ping Per Provider Per Cycle
For each platform, select the model with the **lowest current degradation penalty** (the healthiest model). If even the healthiest model fails, the entire provider is suspect — the degradation penalty propagates to make all models on this provider less attractive. One ping per provider minimizes channel consumption on aggregator providers.

### FR-4: Ping Request Shape
```typescript
{
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 5,
  stream: false,
}
```
No tools, no images, no thinking. Minimal token cost. The response is discarded — only success/failure matters.

### FR-5: Degradation Integration
- **Ping succeeds**: Call `recordSuccess(modelDbId)` — reduces penalty, confirms health.
- **Ping fails with 5xx**: Call `recordFailure(modelDbId, classifyError(err))` — increases penalty via the existing tier system (`'major'` for 5xx).
- **Ping fails with 429**: Call `recordFailure(modelDbId, 'minor')` — mild penalty, could be transient rate limit.
- **Ping fails with non-retryable error (401/403/404)**: Do NOT call `recordFailure` — these are configuration issues, not provider health signals. Log a warning instead.

### FR-6: Zero Rate-Limit Impact
Ping requests must NOT:
- Call `recordRequest()` (would count against RPM/RPD)
- Call `recordTokens()` (would count against TPM/TPD)
- Call `setCooldown()` on failure (would bench the key for real requests)
- Insert into the `requests` table (would pollute analytics)

### FR-7: Event Emission
Each ping cycle emits events via the existing `publish()` system:
```typescript
{ type: 'heartbeat.ping'; provider: string; model: string; success: boolean; latencyMs: number; error?: string; at: number }
{ type: 'heartbeat.cycle_skipped'; reason: 'activity_gate'; lastActivityAgeMs: number; at: number }
```

### FR-8: Dashboard Rendering
The client's `live-events.tsx` shall render `heartbeat.ping` events with a distinct visual indicator. Failures render as `warn` kind; successes as `info` kind. Cycle-skip events are not rendered (too noisy).

### FR-9: Configuration

| Variable | Default | Description |
|---|---|---|
| `HEARTBEAT_ENABLED` | `false` | Enable/disable the heartbeat entirely |
| `HEARTBEAT_INTERVAL_MIN` | `10` | Minutes between ping cycles |
| `HEARTBEAT_ACTIVITY_WINDOW_MIN` | `15` | Max minutes since last user request for pings to fire |
| `HEARTBEAT_TIMEOUT_MS` | `10000` | Timeout per individual ping request |
| `HEARTBEAT_STAGGER_MS` | `2000` | Delay between pings to different providers within one cycle |

---

## 4. Non-Functional Requirements

### NFR-1: Performance
- The heartbeat timer runs on a `setInterval` — it must NEVER block the event loop
- Each ping is an async HTTP call with a configurable timeout (default 10s)
- Staggered pings prevent burst load: 2s delay between providers in a cycle
- The activity-gate check is O(1): a single timestamp comparison

### NFR-2: Backward Compatibility
- `HEARTBEAT_ENABLED=false` (default) means zero behaviour change — no timer, no pings, identical to today
- No changes to `router.ts`, `scoring.ts`, `ratelimit.ts`, or `key-exhaustion.ts`
- Pings never modify `skipModels`, `skipKeys`, cooldowns, or exhaustion state
- Existing tests pass without modification (heartbeat is opt-in and timer-based)

### NFR-3: Correctness
- A ping failure must NOT set a cooldown — cooldowns would bench the key for real requests
- A ping must NOT count toward rate limits — would steal budget from real requests
- The heartbeat must select a key that is NOT on cooldown and NOT exhausted
- If no eligible key exists for a provider, skip that provider for this cycle (don't error)
- If the fallback chain has zero enabled models, the heartbeat does nothing

### NFR-4: Graceful Shutdown
- The timer reference must be stored so `clearInterval` can be called on server shutdown
- In-flight pings at shutdown time are abandoned (not awaited) — they're fire-and-forget

### NFR-5: Token Cost Bound
- Worst case: N providers × 1 ping each × ~10 tokens (in+out) per cycle
- At 10-minute intervals, 5 providers: 50 tokens/cycle × 6 cycles/hour = 300 tokens/hour
- Negligible cost for any provider with free or cheap tokens

---

## 5. Out of Scope

- **Streaming pings** — Non-streaming is simpler, cheaper, and sufficient. Streaming adds complexity (turn-integrity validation) for no health-check benefit.
- **Multi-model pings per provider** — One model per provider per cycle is sufficient. If the provider is healthy, the healthiest model succeeds. If it fails, the degradation penalty propagates via the existing engine to affect all models on that provider.
- **Persistent heartbeat history** — Not needed. The degradation engine's in-memory state (with DB hydration) captures the effect. No new tables.
- **Alerting on heartbeat failures** — The live-event stream is sufficient for now. External alerting (PagerDuty, Slack webhooks) is a future enhancement.
- **Heartbeat-driven cooldown clearing** — A successful ping could theoretically clear a model's cooldown. This is risky (a single success after a rate-limit 429 doesn't mean the limit has reset) and out of scope.

---

## 6. Relationship to Provider-Outage Fast-Fail

These two features are **complementary, not dependent**:

```
Timeline of a provider outage:

   ──────────────────────────────────────────────────────────
   │ Provider goes down          │ User request arrives     │
   │ (no user traffic)           │                          │
   │                             │                          │
   │  ♥ heartbeat detects at     │  Fast-fail detects at    │
   │    minute 10 → degradation  │    attempt 2 → skips     │
   │    penalty accumulates      │    all provider models   │
   │                             │                          │
   │  Without heartbeat: first   │  With heartbeat: bandit  │
   │  request hits dead provider │  already avoids dead     │
   │  and fast-fail must react   │  provider, fast-fail     │
   │                             │  may never fire          │
   ──────────────────────────────────────────────────────────
```

- **Heartbeat alone**: Reduces first-request waste but can't help if the provider goes down *during* a burst of requests.
- **Fast-fail alone**: Reacts instantly within a request but can't help the *first* request that discovers a cold outage.
- **Both together**: Heartbeat pre-degrades sick providers; fast-fail catches outages that happen between heartbeat cycles.
