import type { Pool } from 'pg';
import {
  buildHourlyAverageLatencySeries,
  buildHourlyLatencyHistogram,
  buildLatencyTrendSeries,
  buildUptime24hSeries,
  calculateAvailabilityPercent,
  DEFAULT_LATENCY_ALERT_THRESHOLD_MS,
  DEFAULT_METRICS_LIMIT,
  evaluateLatencyAlert,
  formatUptimeDuration,
  MAX_METRICS_LIMIT,
  sanitizeLatencyThresholdMs,
  sanitizeMetricsLimit,
  summarizeLatencyMetrics,
  type HealthCheckSample,
  type SystemHealthMetricsResponse,
  type SystemHealthSnapshot,
} from './types.js';

export interface ProbeResult {
  connected: boolean;
  latencyMs: number | null;
  message: string;
}

const ENGINE = 'PostgreSQL';
const SERVICE = 'sport-castle-backend';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_24H_SAMPLES = 5_000;
const RECENT_CHECKS = 20;

/**
 * Admin system-health monitor (ported from the pre-split service). Each probe times `select 1` on the
 * app's pool and is kept in an in-memory history for this process (charts, uptime, CSV).
 */
export function createSystemHealth(pool: Pool, opts: { now?: () => Date; probe?: () => Promise<ProbeResult> } = {}) {
  const startedAt = new Date();
  const now = opts.now ?? (() => new Date());
  const history: HealthCheckSample[] = [];
  const history24h: HealthCheckSample[] = [];

  const probe =
    opts.probe ??
    (async (): Promise<ProbeResult> => {
      const t = performance.now();
      try {
        await pool.query('select 1');
        return { connected: true, latencyMs: Math.max(1, Math.round(performance.now() - t)), message: 'Database responding normally.' };
      } catch {
        return { connected: false, latencyMs: null, message: 'Unable to reach the database.' };
      }
    });

  function record(sample: HealthCheckSample, at: Date): void {
    history.push(sample);
    if (history.length > MAX_METRICS_LIMIT) history.splice(0, history.length - MAX_METRICS_LIMIT);
    history24h.push(sample);
    const cutoff = at.getTime() - DAY_MS;
    while (history24h.length > 0 && Date.parse(history24h[0]!.checkedAt) < cutoff) history24h.shift();
    if (history24h.length > MAX_24H_SAMPLES) history24h.splice(0, history24h.length - MAX_24H_SAMPLES);
  }

  async function snapshot(): Promise<SystemHealthSnapshot> {
    const at = now();
    const result = await probe();
    const status = result.connected ? 'operational' : 'degraded';
    record({ checkedAt: at.toISOString(), status, databaseStatus: result.connected ? 'connected' : 'disconnected', latencyMs: result.latencyMs, message: result.message }, at);
    const mem = process.memoryUsage();
    const uptimeSeconds = Math.max(0, Math.floor((at.getTime() - startedAt.getTime()) / 1000));
    const recentChecks = history.slice(-RECENT_CHECKS);
    return {
      service: SERVICE,
      overallStatus: status,
      checkedAt: at.toISOString(),
      startedAt: startedAt.toISOString(),
      uptimeSeconds,
      uptimeFormatted: formatUptimeDuration(uptimeSeconds),
      availabilityPercent: calculateAvailabilityPercent(recentChecks),
      database: {
        engine: ENGINE,
        status: result.connected ? 'connected' : 'disconnected',
        latencyMs: result.latencyMs,
        pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
        message: result.message,
      },
      runtime: {
        nodeVersion: process.version,
        memoryRssMb: Math.round((mem.rss / 1048576) * 10) / 10,
        heapUsedMb: Math.round((mem.heapUsed / 1048576) * 10) / 10,
      },
      recentChecks,
      uptime24h: buildUptime24hSeries([...history24h], at),
      hourlyLatency: buildHourlyAverageLatencySeries([...history24h], at),
      hourlyLatencyHistogram: buildHourlyLatencyHistogram([...history24h], at),
    };
  }

  async function metrics(o: { limit?: unknown; thresholdMs?: unknown; probe?: boolean }): Promise<SystemHealthMetricsResponse> {
    const limit = sanitizeMetricsLimit(o.limit as string | number | undefined, DEFAULT_METRICS_LIMIT);
    const thresholdMs = sanitizeLatencyThresholdMs(o.thresholdMs as string | number | undefined, DEFAULT_LATENCY_ALERT_THRESHOLD_MS);
    let latest = history.at(-1);
    if (o.probe !== false || !latest) {
      await snapshot();
      latest = history.at(-1);
    }
    const window = history.slice(-limit);
    return {
      service: SERVICE,
      engine: ENGINE,
      overallStatus: latest?.status ?? 'operational',
      databaseStatus: latest?.databaseStatus ?? 'connected',
      checkedAt: latest?.checkedAt ?? now().toISOString(),
      thresholdMs,
      alert: evaluateLatencyAlert(latest?.latencyMs ?? null, thresholdMs, latest?.databaseStatus ?? 'connected'),
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      summary: summarizeLatencyMetrics(window, thresholdMs),
      series: buildLatencyTrendSeries(window, thresholdMs),
    };
  }

  return { snapshot, metrics };
}
export type SystemHealth = ReturnType<typeof createSystemHealth>;
