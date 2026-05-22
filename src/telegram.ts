import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RuntimeEnv } from "./types.js";

export class TelegramAlerts {
  private enabled: boolean;
  private offset = 0;
  private chatId?: string;
  private statePath = "./data/telegram-state.json";

  constructor(private env: RuntimeEnv) {
    this.enabled = Boolean(env.telegramBotToken);
    this.chatId = env.telegramChatId ?? this.loadStoredChatId();
  }

  async send(message: string): Promise<void> {
    if (!this.enabled || !this.chatId) return;
    await this.sendTo(this.chatId, message, mainKeyboard());
  }

  async sendStartup(): Promise<void> {
    await this.send([
      "🟢 <b>Polymarket Paper Bot Online</b>",
      "",
      "🧪 Mode: <b>Paper trading only</b>",
      "📡 Feeds: Gamma + Data + CLOB",
      "🛡 Risk engine: <b>enabled</b>",
      "",
      "Use /menu to open controls."
    ].join("\n"));
  }

  async sendApproved(input: { outcome: string; question: string; price: number; size: number; confidence: number }): Promise<void> {
    await this.send([
      "🟢 <b>BUY Signal Approved</b>",
      "",
      `🎯 <b>${escapeHtml(input.outcome)}</b>`,
      `📌 ${escapeHtml(input.question)}`,
      `💵 Limit: <b>${input.price.toFixed(3)}</b>`,
      `📦 Size: <b>$${input.size.toFixed(2)}</b>`,
      `📊 Confidence: <b>${input.confidence}</b>`
    ].join("\n"));
  }

  async sendRejected(input: { question: string; reason: string }): Promise<void> {
    await this.send([
      "🔴 <b>Signal Rejected</b>",
      "",
      `📌 ${escapeHtml(input.question)}`,
      `🛡 ${escapeHtml(input.reason)}`
    ].join("\n"));
  }

  async sendExit(input: { outcome: string; marketId: string; reason: string }): Promise<void> {
    await this.send([
      "🟡 <b>Paper Exit</b>",
      "",
      `🎯 <b>${escapeHtml(input.outcome)}</b>`,
      `🏷 Market: <code>${escapeHtml(input.marketId)}</code>`,
      `🚪 Reason: ${escapeHtml(input.reason)}`
    ].join("\n"));
  }

  async sendError(message: string): Promise<void> {
    await this.send([
      "🚨 <b>Bot Error</b>",
      "",
      `<code>${escapeHtml(message)}</code>`
    ].join("\n"));
  }

  startCommandLoop(handlers: TelegramHandlers): void {
    if (!this.enabled) return;
    void this.commandLoop(handlers);
  }

  private async commandLoop(handlers: TelegramHandlers): Promise<void> {
    while (true) {
      try {
        const updates = await this.call<TelegramUpdate[]>("getUpdates", {
          offset: this.offset,
          timeout: 25,
          allowed_updates: ["message", "callback_query"]
        });
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          await this.handleUpdate(update, handlers);
        }
      } catch {
        await sleep(3000);
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate, handlers: TelegramHandlers): Promise<void> {
    const message = update.message;
    const callback = update.callback_query;
    const chatId = String(message?.chat.id ?? callback?.message?.chat.id ?? "");
    if (!chatId) return;
    this.rememberChatId(chatId);

    if (callback) {
      await this.answerCallback(callback.id);
      await this.route(chatId, callback.data ?? "menu", handlers);
      return;
    }

    const text = message?.text?.trim() ?? "/menu";
    await this.route(chatId, text, handlers);
  }

  private async route(chatId: string, command: string, handlers: TelegramHandlers): Promise<void> {
    const normalized = command.replace(/^\//, "").toLowerCase();
    if (normalized === "start" || normalized === "menu" || normalized === "help") {
      await this.sendTo(chatId, menuText(), mainKeyboard());
      return;
    }
    if (normalized === "status") return this.sendTo(chatId, await handlers.status(), mainKeyboard());
    if (normalized === "scan" || normalized === "discover") return this.sendTo(chatId, await handlers.scan(), mainKeyboard());
    if (normalized === "risk") return this.sendTo(chatId, await handlers.risk(), mainKeyboard());
    if (normalized === "wallets") return this.sendTo(chatId, await handlers.wallets(), mainKeyboard());
    if (normalized === "pause") return this.sendTo(chatId, await handlers.pause(), mainKeyboard());
    if (normalized === "resume") return this.sendTo(chatId, await handlers.resume(), mainKeyboard());
    await this.sendTo(chatId, menuText(), mainKeyboard());
  }

  private async sendTo(chatId: string, message: string, keyboard?: InlineKeyboard): Promise<void> {
    if (!this.enabled) return;
    await this.call("sendMessage", {
      chat_id: chatId,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: keyboard
    });
  }

  private async answerCallback(callbackId: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: callbackId });
  }

  private async call<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
    const url = `https://api.telegram.org/bot${this.env.telegramBotToken}/${method}`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
      const payload = await response.json() as { ok: boolean; result: T };
      return payload.result;
    } catch {
      return [] as T;
    }
  }

  private loadStoredChatId(): string | undefined {
    if (!existsSync(this.statePath)) return undefined;
    try {
      const state = JSON.parse(readFileSync(this.statePath, "utf8")) as { chatId?: string };
      return state.chatId;
    } catch {
      return undefined;
    }
  }

  private rememberChatId(chatId: string): void {
    this.chatId = chatId;
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, JSON.stringify({ chatId }, null, 2));
  }
}

export interface TelegramHandlers {
  status: () => string | Promise<string>;
  scan: () => string | Promise<string>;
  risk: () => string | Promise<string>;
  wallets: () => string | Promise<string>;
  pause: () => string | Promise<string>;
  resume: () => string | Promise<string>;
}

interface TelegramUpdate {
  update_id: number;
  message?: { text?: string; chat: { id: number | string } };
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat: { id: number | string } };
  };
}

interface InlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

function mainKeyboard(): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: "📊 Status", callback_data: "status" },
        { text: "🔎 Discover", callback_data: "discover" }
      ],
      [
        { text: "🛡 Risk", callback_data: "risk" },
        { text: "👛 Wallets", callback_data: "wallets" }
      ],
      [
        { text: "⏸ Pause", callback_data: "pause" },
        { text: "▶️ Resume", callback_data: "resume" }
      ]
    ]
  };
}

function menuText(): string {
  return [
    "🤖 <b>Polymarket Paper Bot</b>",
    "",
    "🟢 Buy signals",
    "🔴 Rejected trades / sells",
    "🟡 Exits",
    "🛡 Risk controls",
    "📊 Status and scan tools",
    "",
    "<b>Commands</b>",
    "/status - bot health",
    "/scan - run one paper scan",
    "/discover - find profitable wallet candidates",
    "/risk - current limits",
    "/wallets - tracked wallets",
    "/pause - pause cycles",
    "/resume - resume cycles"
  ].join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
