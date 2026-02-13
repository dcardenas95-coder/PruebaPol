import { storage } from "../storage";

const DEFAULT_MAX_REQUESTS_PER_SECOND = 8;
const DEFAULT_MAX_REQUESTS_PER_MINUTE = 100;
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_COOLDOWN = 30_000;

export class RateLimiter {
  private requestTimestamps: number[] = [];
  private consecutiveErrors = 0;
  private circuitOpen = false;
  private circuitOpenedAt = 0;

  constructor(
    private maxPerSecond = DEFAULT_MAX_REQUESTS_PER_SECOND,
    private maxPerMinute = DEFAULT_MAX_REQUESTS_PER_MINUTE,
    private circuitBreakerThreshold = CIRCUIT_BREAKER_THRESHOLD,
    private circuitBreakerCooldown = CIRCUIT_BREAKER_COOLDOWN,
  ) {}

  async canProceed(): Promise<{ allowed: boolean; reason?: string; waitMs?: number }> {
    if (this.circuitOpen) {
      const elapsed = Date.now() - this.circuitOpenedAt;
      if (elapsed >= this.circuitBreakerCooldown) {
        this.circuitOpen = false;
        this.consecutiveErrors = 0;
        await this.log("info", `Circuit breaker CLOSED after ${(elapsed / 1000).toFixed(0)}s cooldown`);
      } else {
        const remaining = this.circuitBreakerCooldown - elapsed;
        return {
          allowed: false,
          reason: `Circuit breaker OPEN: ${this.consecutiveErrors} consecutive API errors. Cooldown: ${(remaining / 1000).toFixed(0)}s`,
          waitMs: remaining,
        };
      }
    }

    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter(t => now - t < 60_000);

    const lastSecond = this.requestTimestamps.filter(t => now - t < 1_000);
    if (lastSecond.length >= this.maxPerSecond) {
      const oldestInSecond = Math.min(...lastSecond);
      const waitMs = 1000 - (now - oldestInSecond);
      return {
        allowed: false,
        reason: `Rate limit: ${lastSecond.length}/${this.maxPerSecond} per second`,
        waitMs,
      };
    }

    if (this.requestTimestamps.length >= this.maxPerMinute) {
      const oldestInMinute = Math.min(...this.requestTimestamps);
      const waitMs = 60_000 - (now - oldestInMinute);
      return {
        allowed: false,
        reason: `Rate limit: ${this.requestTimestamps.length}/${this.maxPerMinute} per minute`,
        waitMs,
      };
    }

    return { allowed: true };
  }

  recordRequest(): void {
    this.requestTimestamps.push(Date.now());
  }

  recordSuccess(): void {
    this.consecutiveErrors = 0;
  }

  async recordError(errorMsg?: string): Promise<void> {
    this.consecutiveErrors++;

    if (this.consecutiveErrors >= this.circuitBreakerThreshold && !this.circuitOpen) {
      this.circuitOpen = true;
      this.circuitOpenedAt = Date.now();
      await this.log("error", `Circuit breaker OPENED: ${this.consecutiveErrors} consecutive API errors. Pausing for ${(this.circuitBreakerCooldown / 1000).toFixed(0)}s`);
      await storage.createEvent({
        type: "RISK_ALERT",
        message: `Circuit breaker triggered: ${this.consecutiveErrors} consecutive API errors`,
        data: { consecutiveErrors: this.consecutiveErrors, errorMsg, cooldownMs: this.circuitBreakerCooldown },
        level: "error",
      });
    }
  }

  isCircuitOpen(): boolean {
    if (this.circuitOpen) {
      const elapsed = Date.now() - this.circuitOpenedAt;
      if (elapsed >= this.circuitBreakerCooldown) {
        this.circuitOpen = false;
        this.consecutiveErrors = 0;
        return false;
      }
      return true;
    }
    return false;
  }

  getStatus(): {
    requestsLastSecond: number;
    requestsLastMinute: number;
    consecutiveErrors: number;
    circuitOpen: boolean;
    circuitCooldownRemaining: number;
  } {
    const now = Date.now();
    const lastSecond = this.requestTimestamps.filter(t => now - t < 1_000);
    const lastMinute = this.requestTimestamps.filter(t => now - t < 60_000);
    const cooldownRemaining = this.circuitOpen
      ? Math.max(0, this.circuitBreakerCooldown - (now - this.circuitOpenedAt))
      : 0;

    return {
      requestsLastSecond: lastSecond.length,
      requestsLastMinute: lastMinute.length,
      consecutiveErrors: this.consecutiveErrors,
      circuitOpen: this.circuitOpen,
      circuitCooldownRemaining: cooldownRemaining,
    };
  }

  private async log(level: string, message: string): Promise<void> {
    const ts = new Date().toISOString();
    if (level === "error") {
      console.error(`[${ts}] [RateLimiter] ${message}`);
    } else {
      console.log(`[${ts}] [RateLimiter] ${message}`);
    }
  }
}

export const apiRateLimiter = new RateLimiter();
