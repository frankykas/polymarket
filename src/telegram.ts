import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RuntimeEnv } from "./types.js";

const ICON = {
  online: "\u{1F7E2}",
  buy: "\u{1F4C8}",
  target: "\u{1F3AF}",
  pin: "\u{1F4CC}",
  money: "\u{1F4B5}",
  box: "\u{1F4E6}",
  chart: "\u{1F4CA}",
  search: "\u{1F50E}",
  shield: "\u{1F6E1}",
  wallet: "\u{1F45B}",
  trophy: "\u{1F3C6}",
  pause: "\u{23F8}",
  resume: "\u{25B6}\u{FE0F}",
  reject: "\u{1F534}",
  exit: "\u{1F7E1}",
  door: "\u{1F6AA}",
  alert: "\u{1F6A8}",
  bot: "\u{1F916}",
  lab: "\u{1F9EA}",
  radio: "\u{1F4E1}",
  tag: "\u{1F3F7}\u{FE0F}",
  clipboard: "\u{1F4CB}",
  check: "\u{2705}",
  info: "\u{2139}\u{FE0F}"
} as const;

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
      `${ICON.online} <b>StratiFi Online</b>`,
      "",
      `${ICON.lab} Mode: <b>Paper trading only</b>`,
      `${ICON.radio} Feeds: Gamma + Data + CLOB`,
      `${ICON.shield} Risk engine: <b>enabled</b>`,
      "",
      "Use /menu to open controls."
    ].join("\n"));
  }

  async sendApproved(input: { outcome: string; question: string; price: number; size: number; confidence: number }): Promise<void> {
    await this.send([
      `${ICON.buy} <b>BUY Signal Approved</b>`,
      "",
      `${ICON.target} Outcome: <b>${escapeHtml(input.outcome)}</b>`,
      `${ICON.pin} Market: ${escapeHtml(input.question)}`,
      `${ICON.money} Limit: <b>${input.price.toFixed(3)}</b>`,
      `${ICON.box} Size: <b>$${input.size.toFixed(2)}</b>`,
      `${ICON.chart} Confidence: <b>${input.confidence}</b>`,
      "",
      `${ICON.info} Paper mode only. No live order was placed.`
    ].join("\n"));
  }

  async sendRejected(input: { question: string; reason: string }): Promise<void> {
    await this.send([
      `${ICON.reject} <b>Signal Rejected</b>`,
      "",
      `${ICON.pin} ${escapeHtml(input.question)}`,
      `${ICON.shield} ${escapeHtml(input.reason)}`
    ].join("\n"));
  }

  async sendRejectedSummary(input: { rejected: number; reasons: Map<string, number> }): Promise<void> {
    const topReasons = [...input.reasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason, count]) => `${ICON.shield} <b>${count}</b> ${escapeHtml(reason)}`);
    await this.send([
      `${ICON.clipboard} <b>Risk Filter Summary</b>`,
      "",
      `${ICON.reject} Candidates ignored: <b>${input.rejected}</b>`,
      `${ICON.check} Approved BUY alerts are sent separately.`,
      "",
      "<b>Top reasons</b>",
      ...topReasons,
      "",
      `${ICON.info} These are normal skips, not bot errors.`
    ].join("\n"));
  }

  async sendExit(input: { outcome: string; marketId: string; reason: string }): Promise<void> {
    await this.send([
      `${ICON.exit} <b>Paper Exit</b>`,
      "",
      `${ICON.target} <b>${escapeHtml(input.outcome)}</b>`,
      `${ICON.tag} Market: <code>${escapeHtml(input.marketId)}</code>`,
      `${ICON.door} Reason: ${escapeHtml(input.reason)}`
    ].join("\n"));
  }

  async sendError(message: string): Promise<void> {
    await this.send([
      `${ICON.alert} <b>Bot Error</b>`,
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
    if (normalized === "topwallets") return this.sendTo(chatId, await handlers.topWallets(), mainKeyboard());
    if (normalized === "performance") return this.sendTo(chatId, await handlers.performance(), mainKeyboard());
    if (normalized === "shadow") return this.sendTo(chatId, await handlers.shadow(), mainKeyboard());
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
  topWallets: () => string | Promise<string>;
  performance: () => string | Promise<string>;
  shadow: () => string | Promise<string>;
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
        { text: `${ICON.chart} Status`, callback_data: "status" },
        { text: `${ICON.search} Discover`, callback_data: "discover" }
      ],
      [
        { text: `${ICON.shield} Risk`, callback_data: "risk" },
        { text: `${ICON.wallet} Wallets`, callback_data: "wallets" }
      ],
      [
        { text: `${ICON.trophy} Top Wallets`, callback_data: "topwallets" }
      ],
      [
        { text: `${ICON.buy} Performance`, callback_data: "performance" }
      ],
      [
        { text: `${ICON.pause} Pause`, callback_data: "pause" },
        { text: `${ICON.resume} Resume`, callback_data: "resume" }
      ]
    ]
  };
}

function menuText(): string {
  return [
    `${ICON.bot} <b>StratiFi Paper Bot</b>`,
    "",
    `${ICON.buy} Buy signals`,
    `${ICON.reject} Risk-filter summaries`,
    `${ICON.exit} Paper exits`,
    `${ICON.shield} Risk controls`,
    `${ICON.chart} Status and scan tools`,
    "",
    "<b>Commands</b>",
    "/status - bot health",
    "/scan - run one paper scan",
    "/discover - find profitable wallet candidates",
    "/topwallets - ranked wallet intelligence",
    "/performance - paper PnL report",
    "/shadow - shadow-copy backtest",
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
