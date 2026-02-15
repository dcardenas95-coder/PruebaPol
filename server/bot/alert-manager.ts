import { storage } from "../storage";

export type AlertLevel = "info" | "warning" | "critical";

export interface Alert {
  id: string;
  level: AlertLevel;
  title: string;
  message: string;
  timestamp: string;
  resolved: boolean;
  resolvedAt: string | null;
  key: string;
}

const MAX_ALERT_HISTORY = 100;
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;

class AlertManager {
  private alerts: Alert[] = [];
  private activeAlerts: Map<string, Alert> = new Map();
  private lastAlertTime: Map<string, number> = new Map();
  private telegramBotToken: string | null = null;
  private telegramChatId: string | null = null;
  private telegramEnabled = false;

  configure(config: { telegramBotToken?: string; telegramChatId?: string }): void {
    if (config.telegramBotToken && config.telegramChatId) {
      this.telegramBotToken = config.telegramBotToken;
      this.telegramChatId = config.telegramChatId;
      this.telegramEnabled = true;
      console.log("[AlertManager] Telegram notifications enabled");
    }
  }

  isTelegramConfigured(): boolean {
    return this.telegramEnabled;
  }

  async sendAlert(level: AlertLevel, title: string, message: string, key: string): Promise<void> {
    const lastTime = this.lastAlertTime.get(key);
    if (lastTime && Date.now() - lastTime < ALERT_COOLDOWN_MS) {
      return;
    }

    const existing = this.activeAlerts.get(key);
    if (existing && !existing.resolved) {
      return;
    }

    const alert: Alert = {
      id: `alert_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      level,
      title,
      message,
      timestamp: new Date().toISOString(),
      resolved: false,
      resolvedAt: null,
      key,
    };

    this.alerts.push(alert);
    this.activeAlerts.set(key, alert);
    this.lastAlertTime.set(key, Date.now());

    if (this.alerts.length > MAX_ALERT_HISTORY) {
      this.alerts = this.alerts.slice(-MAX_ALERT_HISTORY);
    }

    console.log(`[Alert] ${level.toUpperCase()}: ${title} - ${message}`);

    try {
      await storage.createEvent({
        type: "RISK_ALERT",
        message: `[${level.toUpperCase()}] ${title}: ${message}`,
        data: { alertKey: key, level, title },
        level,
      });
    } catch {}

    if (this.telegramEnabled && (level === "critical" || level === "warning")) {
      await this.sendTelegram(level, title, message);
    }
  }

  resolveAlert(key: string): void {
    const alert = this.activeAlerts.get(key);
    if (alert && !alert.resolved) {
      alert.resolved = true;
      alert.resolvedAt = new Date().toISOString();
    }
  }

  getActiveAlerts(): Alert[] {
    return Array.from(this.activeAlerts.values()).filter(a => !a.resolved);
  }

  getAllAlerts(limit = 50): Alert[] {
    return this.alerts.slice(-limit).reverse();
  }

  getAlertsSummary(): { active: number; critical: number; warning: number; info: number; total: number; telegramEnabled: boolean } {
    const active = this.getActiveAlerts();
    return {
      active: active.length,
      critical: active.filter(a => a.level === "critical").length,
      warning: active.filter(a => a.level === "warning").length,
      info: active.filter(a => a.level === "info").length,
      total: this.alerts.length,
      telegramEnabled: this.telegramEnabled,
    };
  }

  private async sendTelegram(level: AlertLevel, title: string, message: string): Promise<void> {
    if (!this.telegramBotToken || !this.telegramChatId) return;

    const prefix = level === "critical" ? "[CRITICAL]" : level === "warning" ? "[WARNING]" : "[INFO]";
    const text = `${prefix} *PolyMaker Alert*\n\n*${title}*\n${message}\n\n_${new Date().toLocaleString("es-CO")}_`;

    try {
      const resp = await fetch(`https://api.telegram.org/bot${this.telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.telegramChatId,
          text,
          parse_mode: "Markdown",
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        console.error(`[AlertManager] Telegram send failed: HTTP ${resp.status} - ${body.slice(0, 200)}`);
      }
    } catch (err: any) {
      console.error(`[AlertManager] Telegram send error: ${err.message}`);
    }
  }

  async testTelegram(): Promise<{ success: boolean; error?: string }> {
    if (!this.telegramBotToken || !this.telegramChatId) {
      return { success: false, error: "Telegram no configurado. Configura TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID." };
    }
    try {
      const resp = await fetch(`https://api.telegram.org/bot${this.telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.telegramChatId,
          text: "[OK] *PolyMaker* - Conexion de alertas verificada correctamente.",
          parse_mode: "Markdown",
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { success: false, error: `HTTP ${resp.status}: ${body.slice(0, 200)}` };
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}

export const alertManager = new AlertManager();

if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
  alertManager.configure({
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
  });
}
