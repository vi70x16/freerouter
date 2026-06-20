/**
 * Integration tests for Provider Health Heartbeat.
 *
 * Each test re-imports modules in isolation to avoid cross-test contamination
 * from module-level cached config and state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('Provider Health Heartbeat', () => {
  let chatCompletion: ReturnType<typeof vi.fn>;
  let publishedEvents: any[];
  let recordActivity: () => void;
  let startHeartbeat: () => void;
  let stopHeartbeat: () => void;
  let initDb: (path?: string) => any;
  let getDb: () => any;
  let setSetting: (key: string, value: string) => void;
  let getPenalty: (modelDbId: number) => number;
  let recordFailure: (modelDbId: number, tier: 'minor' | 'major') => void;
  let initDegradation: () => void;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 6, 1, 12, 0, 0));
    process.env.ENCRYPTION_KEY = '0'.repeat(64);

    // Setup provider mock
    chatCompletion = vi.fn();
    const fakeProvider = { name: 'fake', chatCompletion } as any;

    vi.doMock('../../providers/index.js', async (importOriginal) => {
      const actual = await importOriginal() as any;
      return { ...actual, buildProviderFor: () => fakeProvider };
    });

    publishedEvents = [];
    vi.doMock('../../services/events.js', () => ({
      publish: vi.fn((evt: any) => publishedEvents.push(evt)),
    }));

    vi.doMock('../../lib/crypto.js', async (importOriginal) => {
      const actual = await importOriginal() as any;
      return { ...actual, decrypt: vi.fn(() => 'mocked-api-key') };
    });

    vi.doMock('../../services/ratelimit.js', async (importOriginal) => {
      const actual = await importOriginal() as any;
      return { ...actual, isOnCooldown: vi.fn(() => false) };
    });

    vi.doMock('../../services/key-exhaustion.js', () => ({
      isExhausted: vi.fn(() => false),
    }));

    // Import fresh modules
    const heartbeatModule = await import('../../services/heartbeat.js');
    const dbModule = await import('../../db/index.js');
    const degradationModule = await import('../../services/degradation.js');

    recordActivity = heartbeatModule.recordActivity;
    startHeartbeat = heartbeatModule.startHeartbeat;
    stopHeartbeat = heartbeatModule.stopHeartbeat;
    initDb = dbModule.initDb;
    getDb = dbModule.getDb;
    setSetting = dbModule.setSetting;
    getPenalty = degradationModule.getPenalty;
    recordFailure = degradationModule.recordFailure;
    initDegradation = degradationModule.initDegradation;

    initDb(':memory:');
    initDegradation();

    // Enable heartbeat via DB setting
    setSetting('heartbeat_enabled', 'true');
    setSetting('heartbeat_interval_min', '10');
    setSetting('heartbeat_activity_window_min', '15');
  });

  afterEach(() => {
    stopHeartbeat();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setupProvider(platform = 'testprov', modelId = 'test-model') {
    const db = getDb();
    db.prepare('DELETE FROM fallback_config').run();
    db.prepare(`INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('${platform}', '${modelId}', 'Test Model', 1, 1, 1)`).run();
    const id = (db.prepare(`SELECT id FROM models WHERE platform = '${platform}' AND model_id = '${modelId}'`).get() as any).id;
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(id);
    db.prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('${platform}', 'Key 1', 'enc', 'iv', 'tag', 'healthy', 1)`).run();
    return id;
  }

  // ── Activity Gating ────────────────────────────────────────────────────

  describe('Activity gating', () => {
    it('cycle is skipped when no activity has ever occurred', async () => {
      startHeartbeat();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

      const skipEvents = publishedEvents.filter(e => e.type === 'heartbeat.cycle_skipped');
      expect(skipEvents.length).toBeGreaterThanOrEqual(1);
      expect(skipEvents[0].reason).toBe('activity_gate');
      expect(skipEvents[0].lastActivityAgeMs).toBe(-1);
    });

    it('cycle is skipped when last activity is older than the activity window', async () => {
      recordActivity();
      // Advance past the activity window (15 min)
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);

      startHeartbeat();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

      const skipEvents = publishedEvents.filter(e => e.type === 'heartbeat.cycle_skipped');
      expect(skipEvents.length).toBeGreaterThanOrEqual(1);
      expect(skipEvents[0].reason).toBe('activity_gate');
      expect(skipEvents[0].lastActivityAgeMs).toBeGreaterThan(15 * 60 * 1000);
    });

    it('cycle proceeds when activity is recent', async () => {
      setupProvider();
      chatCompletion.mockResolvedValueOnce({
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      recordActivity();
      startHeartbeat();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

      const pingEvents = publishedEvents.filter(e => e.type === 'heartbeat.ping');
      expect(pingEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Ping Classification ─────────────────────────────────────────────────

  describe('Ping success/failure classification', () => {
    it('successful ping records success and reduces degradation penalty', async () => {
      const modelId = setupProvider();

      // Add some penalty first
      recordFailure(modelId, 'major');
      const penaltyBefore = getPenalty(modelId);
      expect(penaltyBefore).toBeGreaterThan(0);

      chatCompletion.mockResolvedValueOnce({
        choices: [{ message: { role: 'assistant', content: 'pong' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      recordActivity();
      startHeartbeat();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

      const pingEvents = publishedEvents.filter(e => e.type === 'heartbeat.ping');
      expect(pingEvents.length).toBeGreaterThanOrEqual(1);
      expect(pingEvents[0].success).toBe(true);
      expect(pingEvents[0].provider).toBe('testprov');
      expect(pingEvents[0].latencyMs).toBeGreaterThanOrEqual(0);

      // Penalty should have decreased
      expect(getPenalty(modelId)).toBeLessThan(penaltyBefore);
    });

    it('failed ping (5xx) records major failure and increases penalty', async () => {
      const modelId = setupProvider();

      chatCompletion.mockRejectedValueOnce(new Error('503 Service Unavailable'));

      recordActivity();
      startHeartbeat();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

      const pingEvents = publishedEvents.filter(e => e.type === 'heartbeat.ping');
      expect(pingEvents.length).toBeGreaterThanOrEqual(1);
      expect(pingEvents[0].success).toBe(false);
      expect(pingEvents[0].error).toBeDefined();

      expect(getPenalty(modelId)).toBeGreaterThan(0);
    });

    it('failed ping (429) records minor failure', async () => {
      const modelId = setupProvider();

      chatCompletion.mockRejectedValueOnce(new Error('429 Rate limited'));

      recordActivity();
      startHeartbeat();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

      const pingEvents = publishedEvents.filter(e => e.type === 'heartbeat.ping');
      expect(pingEvents.length).toBeGreaterThanOrEqual(1);
      expect(pingEvents[0].success).toBe(false);

      expect(getPenalty(modelId)).toBeGreaterThan(0);
    });

    it('non-retryable error (401) does NOT penalize the model', async () => {
      const modelId = setupProvider();

      chatCompletion.mockRejectedValueOnce(new Error('401 Unauthorized'));

      recordActivity();
      startHeartbeat();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

      const pingEvents = publishedEvents.filter(e => e.type === 'heartbeat.ping');
      expect(pingEvents.length).toBeGreaterThanOrEqual(1);
      expect(pingEvents[0].success).toBe(false);

      // Non-retryable errors don't penalize
      expect(getPenalty(modelId)).toBe(0);
    });
  });

  // ── Provider Selection ──────────────────────────────────────────────────

  describe('Model selection (healthiest per provider)', () => {
    it('selects the model with the lowest penalty for pinging', async () => {
      const db = getDb();
      db.prepare('DELETE FROM fallback_config').run();

      db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('selecttest', 'healthy', 'Healthy', 1, 1, 1)").run();
      db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('selecttest', 'sick', 'Sick', 2, 2, 1)").run();
      const healthyId = (db.prepare("SELECT id FROM models WHERE model_id = 'healthy' AND platform = 'selecttest'").get() as any).id;
      const sickId = (db.prepare("SELECT id FROM models WHERE model_id = 'sick' AND platform = 'selecttest'").get() as any).id;

      db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)").run(healthyId);
      db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, 1)").run(sickId);
      db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('selecttest', 'Key 1', 'enc', 'iv', 'tag', 'healthy', 1)").run();

      // Make sick model have a high penalty
      recordFailure(sickId, 'major');
      recordFailure(sickId, 'major');
      recordFailure(sickId, 'major');

      expect(getPenalty(healthyId)).toBeLessThan(getPenalty(sickId));

      chatCompletion.mockResolvedValueOnce({
        choices: [{ message: { role: 'assistant', content: 'pong' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      recordActivity();
      startHeartbeat();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

      const pingEvents = publishedEvents.filter(e => e.type === 'heartbeat.ping');
      expect(pingEvents.length).toBeGreaterThanOrEqual(1);
      expect(pingEvents[0].model).toBe('healthy');
    });
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────

  describe('Lifecycle (start/stop)', () => {
    it('startHeartbeat is a no-op when disabled', () => {
      setSetting('heartbeat_enabled', 'false');
      startHeartbeat();
      vi.advanceTimersByTime(30 * 60 * 1000);
      expect(publishedEvents.length).toBe(0);
    });

    it('stopHeartbeat is safe to call even if never started', () => {
      expect(() => stopHeartbeat()).not.toThrow();
    });

    it('stopHeartbeat clears the timer', () => {
      recordActivity();
      startHeartbeat();
      stopHeartbeat();

      const eventsBefore = publishedEvents.length;
      vi.advanceTimersByTime(10 * 60 * 1000 + 1000);
      expect(publishedEvents.length).toBe(eventsBefore);
    });
  });
});
