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
  private adminChatId?: string;
  private publicChatId?: string;
  private statePath = "./data/telegram-state.json";

  constructor(private env: RuntimeEnv) {
    this.enabled = Boolean(env.telegramBotToken);
    this.adminChatId = env.telegramAdminChatId ?? env.telegramChatId ?? this.loadStoredAdminChatId();
    this.publicChatId = env.telegramPublicChatId;
  }

  async send(message: string): Promise<void> {
    await this.sendAdmin(message);
  }

  async sendAdmin(message: string): Promise<void> {
    if (!this.enabled || !this.adminChatId) return;
    await this.sendTo(this.adminChatId, message, mainKeyboard());
  }

  async sendPublic(message: string): Promise<void> {
    const chatId = this.publicChatId ?? this.adminChatId;
    if (!this.enabled || !chatId) return;
    await this.sendTo(chatId, message);
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
    await this.sendPublic([
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

  async sendPaperEntry(input: {
    outcome: string;
    marketId: string;
    price: number;
    sizeUsd: number;
    shares: number;
    unrealizedPnl: number;
    totalPnl: number;
    equity: number;
    availableCash: number;
  }): Promise<void> {
    await this.sendPublic([
      `${ICON.buy} <b>Paper Trade Opened</b>`,
      "",
      `${ICON.target} Outcome: <b>${escapeHtml(input.outcome)}</b>`,
      `${ICON.tag} Market: <code>${escapeHtml(input.marketId)}</code>`,
      `${ICON.money} Entry: <b>${input.price.toFixed(3)}</b> for <b>$${input.sizeUsd.toFixed(2)}</b>`,
      `${ICON.box} Shares: <b>${input.shares.toFixed(2)}</b>`,
      `${ICON.chart} Trade PnL: <b>$${input.unrealizedPnl.toFixed(2)}</b>`,
      `${ICON.money} Total PnL: <b>$${input.totalPnl.toFixed(2)}</b>`,
      `${ICON.wallet} Equity: <b>$${input.equity.toFixed(2)}</b> | Cash: <b>$${input.availableCash.toFixed(2)}</b>`,
      "",
      `${ICON.info} Balance trail updated. Paper mode only.`
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

  async sendRejectedSummary(input: {
    rejected: number;
    reasons: Map<string, number>;
    exposure?: { openExposure: number; maxOpenExposure: number; activeExposureCap: number; remainingExposure: number };
  }): Promise<void> {
    const topReasons = [...input.reasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason, count]) => `${ICON.shield} <b>${count}</b> ${escapeHtml(reason)}`);
    const exposureBlocked = input.reasons.has("max open exposure reached") || input.reasons.has("reserve cash protected");
    const capitalLockupBlocked = [...input.reasons.keys()].some((reason) =>
      reason.includes("capital lockup") || reason.includes("too far from resolution")
    );
    const exposureLines = input.exposure && exposureBlocked
      ? [
          "",
          "<b>Exposure</b>",
          `${ICON.money} Open exposure: <b>$${input.exposure.openExposure.toFixed(2)}</b> / $${input.exposure.activeExposureCap.toFixed(2)} active cap`,
          `${ICON.shield} Hard cap: <b>$${input.exposure.maxOpenExposure.toFixed(2)}</b>`,
          `${ICON.info} New buys are paused until exposure drops, reserve cash is released, or positions close.`
        ]
      : [];
    const lockupLines = capitalLockupBlocked
      ? [
          "",
          "<b>Capital Lockup</b>",
          `${ICON.shield} Long-dated markets are skipped so paper capital stays focused on active, copyable opportunities.`,
          `${ICON.info} Increase MAX_TIME_TO_RESOLUTION_HOURS only if you want the bot to hold capital through slower markets.`
        ]
      : [];
    await this.send([
      `${ICON.clipboard} <b>Risk Filter Summary</b>`,
      "",
      `${ICON.reject} Candidates ignored: <b>${input.rejected}</b>`,
      `${ICON.check} Approved BUY alerts are sent separately.`,
      "",
      "<b>Top reasons</b>",
      ...topReasons,
      ...exposureLines,
      ...lockupLines,
      "",
      `${ICON.info} These are normal skips, not bot errors.`
    ].join("\n"));
  }

  async sendExit(input: {
    outcome: string;
    marketId: string;
    reason: string;
    price?: number;
    sizeUsd?: number;
    realizedPnl?: number;
    totalPnl?: number;
    equity?: number;
    availableCash?: number;
  }): Promise<void> {
    await this.sendPublic([
      `${ICON.exit} <b>Paper Exit</b>`,
      "",
      `${ICON.target} <b>${escapeHtml(input.outcome)}</b>`,
      `${ICON.tag} Market: <code>${escapeHtml(input.marketId)}</code>`,
      input.price !== undefined ? `${ICON.money} Exit mark: <b>${input.price.toFixed(3)}</b>` : "",
      input.sizeUsd !== undefined ? `${ICON.box} Exit value: <b>$${input.sizeUsd.toFixed(2)}</b>` : "",
      input.realizedPnl !== undefined ? `${ICON.chart} Trade PnL: <b>$${input.realizedPnl.toFixed(2)}</b>` : "",
      input.totalPnl !== undefined ? `${ICON.money} Total PnL: <b>$${input.totalPnl.toFixed(2)}</b>` : "",
      input.equity !== undefined && input.availableCash !== undefined ? `${ICON.wallet} Equity: <b>$${input.equity.toFixed(2)}</b> | Cash: <b>$${input.availableCash.toFixed(2)}</b>` : "",
      `${ICON.door} Reason: ${escapeHtml(input.reason)}`
    ].filter(Boolean).join("\n"));
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
    if (!this.adminChatId) {
      this.rememberAdminChatId(chatId);
    }
    if (this.adminChatId !== chatId) return;

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
    if (normalized === "risklog") return this.sendTo(chatId, await handlers.riskLog(), mainKeyboard());
    if (normalized === "wallets") return this.sendTo(chatId, await handlers.wallets(), mainKeyboard());
    if (normalized === "topwallets") return this.sendTo(chatId, await handlers.topWallets(), mainKeyboard());
    if (normalized === "agents") return this.sendTo(chatId, await handlers.agents(), mainKeyboard());
    if (normalized === "bankroll" || normalized === "pnl") return this.sendTo(chatId, await handlers.bankroll(), mainKeyboard());
    if (normalized === "ledger" || normalized === "trades") return this.sendTo(chatId, await handlers.ledger(), mainKeyboard());
    if (normalized === "performance") return this.sendTo(chatId, await handlers.performance(), mainKeyboard());
    if (normalized === "positions") return this.sendTo(chatId, await handlers.positions(), mainKeyboard());
    if (normalized.startsWith("close ")) return this.sendTo(chatId, await handlers.close(command.replace(/^\/?close\s+/i, "").trim()), mainKeyboard());
    if (normalized === "closeall") return this.sendTo(chatId, await handlers.closeAll(false), confirmCloseAllKeyboard());
    if (normalized === "confirmcloseall") return this.sendTo(chatId, await handlers.closeAll(true), mainKeyboard());
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

  private loadStoredAdminChatId(): string | undefined {
    if (!existsSync(this.statePath)) return undefined;
    try {
      const state = JSON.parse(readFileSync(this.statePath, "utf8")) as { adminChatId?: string; chatId?: string };
      return state.adminChatId ?? state.chatId;
    } catch {
      return undefined;
    }
  }

  private rememberAdminChatId(chatId: string): void {
    this.adminChatId = chatId;
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, JSON.stringify({ adminChatId: chatId }, null, 2));
  }
}

export interface TelegramHandlers {
  status: () => string | Promise<string>;
  scan: () => string | Promise<string>;
  risk: () => string | Promise<string>;
  riskLog: () => string | Promise<string>;
  wallets: () => string | Promise<string>;
  topWallets: () => string | Promise<string>;
  agents: () => string | Promise<string>;
  bankroll: () => string | Promise<string>;
  ledger: () => string | Promise<string>;
  performance: () => string | Promise<string>;
  positions: () => string | Promise<string>;
  close: (positionRef: string) => string | Promise<string>;
  closeAll: (confirmed: boolean) => string | Promise<string>;
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
        { text: `${ICON.clipboard} Risk Log`, callback_data: "risklog" }
      ],
      [
        { text: `${ICON.wallet} Wallets`, callback_data: "wallets" }
      ],
      [
        { text: `${ICON.trophy} Top Wallets`, callback_data: "topwallets" },
        { text: `${ICON.money} Bankroll`, callback_data: "bankroll" }
      ],
      [
        { text: `${ICON.clipboard} Trade Ledger`, callback_data: "ledger" }
      ],
      [
        { text: `${ICON.bot} Agents`, callback_data: "agents" }
      ],
      [
        { text: `${ICON.buy} Performance`, callback_data: "performance" },
        { text: `${ICON.box} Positions`, callback_data: "positions" }
      ],
      [
        { text: `${ICON.lab} Shadow`, callback_data: "shadow" },
        { text: `${ICON.door} Close All`, callback_data: "closeall" }
      ],
      [
        { text: `${ICON.pause} Pause`, callback_data: "pause" },
        { text: `${ICON.resume} Resume`, callback_data: "resume" }
      ]
    ]
  };
}

function confirmCloseAllKeyboard(): InlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: `${ICON.alert} Confirm Close All`, callback_data: "confirmcloseall" }],
      [{ text: `${ICON.info} Cancel`, callback_data: "positions" }]
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
    "/agents - three-agent activity summary",
    "/bankroll - current paper bankroll and PnL",
    "/ledger - paper trade PnL and balance trail",
    "/performance - paper PnL report",
    "/positions - list open paper positions",
    "/close <number-or-id> - close one paper position",
    "/closeall - close every open paper position after confirmation",
    "/shadow - shadow-copy backtest",
    "/risk - current limits",
    "/risklog - latest risk decisions and rejection causes",
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
