# Global Settings Panel — Requirements

## 1. Problem Statement

The dashboard has **no Settings tab**. Feature toggles and configuration are scattered:

| Setting | Current location | Problem |
|---|---|---|
| Routing strategy | Models page (FallbackPage) | Buried inside the fallback chain UI |
| Unified API key | Keys page | Mixed with API key management |
| Sticky sessions | Env var only (`STICKY_SESSION_ENABLED`) | No UI — requires SSH + restart |
| Fast-fail threshold | Env var only (`PROVIDER_FASTFAIL_THRESHOLD`) | No UI — requires SSH + restart |
| Heartbeat toggle | Env var only (`HEARTBEAT_ENABLED`) | No UI — requires SSH + restart |
| Heartbeat interval | Env var only (`HEARTBEAT_INTERVAL_MIN`) | No UI — requires SSH + restart |

When a new experimental feature ships (like provider-outage fast-fail or provider health heartbeat), the only way to toggle it is editing environment variables and restarting the server. Operators need a **single panel** to see what's active, toggle features on/off, and tune parameters — without touching the terminal.

### Why This Matters for the Sibling Specs

Both the **fast-fail** and **heartbeat** specs introduce controversial features that operators may want to disable quickly if they misbehave. Without a UI toggle:
- Disabling requires SSH access + env var edit + restart
- There's no at-a-glance view of "what experimental stuff is running right now"
- Operators can't A/B test features (enable heartbeat for a day, compare behavior, disable)

---

## 2. User Stories

### US-1: Dedicated Settings Tab
**As an operator**, I want a Settings tab in the dashboard navigation so I can find all configuration in one place without hunting through other pages.

### US-2: Feature Toggles
**As an operator**, I want toggle switches for each experimental feature (fast-fail, heartbeat, sticky sessions) with clear labels and descriptions, so I can enable/disable features with one click.

### US-3: Parameter Tuning
**As an operator**, I want numeric inputs for tunable parameters (fast-fail threshold, heartbeat interval, heartbeat activity window) with sensible defaults and validation, so I can fine-tune behavior without editing env vars.

### US-4: Live vs Restart-Required Indicators
**As an operator**, I want to see which settings take effect immediately and which require a server restart, so I know when to restart vs. when the change is already live.

### US-5: Persistence
**As an operator**, I want settings to persist across server restarts without editing `.env` files, so a restart doesn't undo my dashboard changes.

### US-6: Current State Visibility
**As an operator**, I want to see the current active state of every feature at a glance — enabled/disabled badges, current parameter values — without opening individual toggles.

### US-7: Safe Defaults
**As a new user**, experimental features should default to OFF (or conservative values), so a fresh installation behaves identically to today.

### US-8: Grouped Sections
**As an operator**, I want settings grouped by category (Routing, Resilience, Sessions) with clear section headers, so the panel stays organized as more features are added.

---

## 3. Functional Requirements

### FR-1: Settings Tab in Navigation
Add a **Settings** tab to the dashboard navigation bar (the existing 4-tab nav: Models, Playground, Keys, Analytics). Route: `/settings`. Icon: `Settings` from lucide-react.

### FR-2: Settings API Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `GET /api/settings/features` | GET | Fetch all feature settings with current values, defaults, and live/restart metadata |
| `PUT /api/settings/features` | PUT | Update one or more feature settings (partial update supported) |

Both endpoints require the unified API key (same auth as all other dashboard API calls).

### FR-3: Settings Schema

Each feature setting has this shape:

```typescript
interface FeatureSetting {
  key: string;               // e.g. "provider_fastfail_enabled"
  label: string;             // "Provider-Outage Fast-Fail"
  description: string;       // "Skip all models from a provider when ≥N distinct models return 5xx"
  type: 'boolean' | 'number';
  value: boolean | number;   // current persisted value
  default: boolean | number; // factory default
  min?: number;              // for number type
  max?: number;              // for number type
  effect: 'live' | 'restart'; // whether the change takes effect immediately or needs restart
  group: string;             // section grouping
}
```

### FR-4: Initial Settings Registry

| Key | Label | Type | Default | Effect | Group |
|---|---|---|---|---|---|
| `provider_fastfail_enabled` | Provider-Outage Fast-Fail | boolean | `true` | restart | Resilience |
| `provider_fastfail_threshold` | Fast-Fail Threshold | number (1–10) | `2` | restart | Resilience |
| `heartbeat_enabled` | Provider Health Heartbeat | boolean | `false` | restart | Resilience |
| `heartbeat_interval_min` | Heartbeat Interval (minutes) | number (1–60) | `10` | restart | Resilience |
| `heartbeat_activity_window_min` | Activity Window (minutes) | number (5–60) | `15` | restart | Resilience |
| `sticky_session_enabled` | Sticky Sessions | boolean | `false` | live | Sessions |

### FR-5: Section Grouping

Settings are rendered in collapsible sections:

- **Resilience** — Features that affect how the proxy handles provider failures
- **Sessions** — Features that affect session/conversation routing

New groups are added as new features ship. The grouping is defined server-side in the settings registry, not hardcoded in the client.

### FR-6: Toggle + Parameter Pairing

When a feature has both an enable toggle and numeric parameters, the numeric inputs are **disabled** (greyed out) when the feature toggle is OFF. This prevents confusion about whether a value matters when the feature is disabled.

### FR-7: Save Pattern

Use the existing `FloatingBar` pattern (already used on Models and Keys pages):
- Changes accumulate in local state
- A floating action bar appears at the bottom: "N unsaved changes" with **Discard** and **Save** buttons
- Save calls `PUT /api/settings/features` with the changed values
- Success toast confirms the save
- For `restart`-effect settings, show a badge: "Restart required to apply"

### FR-8: Restart-Required Indicator

Settings with `effect: 'restart'` show a small `↻ restart` badge next to their label. After saving a restart-effect change, a banner appears at the top of the Settings page:

> "Some changes require a server restart to take effect."

This banner persists until the server is restarted (the `GET` response includes a `pendingRestart` flag when saved values differ from the running values).

### FR-9: Persistence via Settings Table

Settings are stored in the existing `settings` DB table (key-value store already used for `routing_strategy` and `routing_custom_weights`). The settings module reads from the DB at startup and falls back to env vars, then factory defaults.

**Priority order**: DB value → env var → factory default.

This means:
- A fresh install with no DB values uses env vars (backward compatible)
- Once an operator saves via the dashboard, the DB value takes precedence
- Deleting a DB row falls back to the env var

---

## 4. Non-Functional Requirements

### NFR-1: Backward Compatibility
- Env vars continue to work as before — the DB layer is additive, not a replacement
- A deployment that never opens the Settings tab behaves identically to today
- Existing tests pass without modification

### NFR-2: Authentication
- Settings endpoints use the same unified API key auth as all other dashboard endpoints
- No new auth mechanism needed

### NFR-3: Performance
- `GET /api/settings/features` returns a small static-ish JSON payload (< 2KB)
- `PUT /api/settings/features` writes only changed keys (partial update)
- No polling — the client fetches once on tab mount, refetches after save

### NFR-4: Extensibility
- Adding a new feature toggle is a one-line addition to the settings registry (server-side)
- The client renders settings generically from the schema — no per-feature client code
- Groups are defined by the `group` field — new groups appear automatically

### NFR-5: Validation
- Server validates all incoming values against the schema (type, min/max)
- Invalid values return 400 with a clear error message
- The client shows inline validation errors before the save button is clicked

---

## 5. Out of Scope

- **Routing strategy/weights** — Already has a good UI in the Models page. Moving it to Settings would break existing muscle memory.
- **API key management** — Lives on the Keys page by design (keys are a separate concern from feature toggles).
- **Custom provider configuration** — Lives on the Keys page (provider CRUD is different from feature toggles).
- **User management / multi-user auth** — Single-operator tool; the unified API key is sufficient.
- **Real-time settings sync** — No WebSocket for live setting updates across dashboard instances. Refresh after save is acceptable.
- **Setting import/export** — Not needed for a single-instance tool.
