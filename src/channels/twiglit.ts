import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel } from '../types.js';

/**
 * Twiglit channel (polling).
 *
 * Twiglit (https://app.twigl.it) exposes two surfaces with different auth:
 *
 *  - Chat  — `/api/chats/*`, WhatsApp-style append-only seq log, authed by a
 *            SESSION token (not the API key). A chat is itself a twig; the
 *            routing key is `chat_twig_id`. We poll `?since_seq=` and reply via
 *            POST, optionally AS a bot `ai_connection`. JID: `twiglit:chat:<id>`.
 *  - Twig  — `/api/v1/*`, authed by a `twg_` API key. We poll twigs assigned to
 *            a watched user, hand each to the agent as a work item, and reply as
 *            a comment on that twig. JID: `twiglit:twig:<id>`.
 *
 * Each surface activates independently based on which env vars are present, so
 * the twig surface can run on just the API key while chat waits for a session
 * token. See .env.example (TWIGLIT_*).
 */

const CHAT_PREFIX = 'twiglit:chat:';
const TWIG_PREFIX = 'twiglit:twig:';

/** Chat message types that are streaming artifacts or noise — never delivered. */
const SKIP_MESSAGE_TYPES = new Set(['ai_chunk', 'ai_final', 'system']);

interface TwiglitConfig {
  baseUrl: string;
  apiKey: string; // twg_... — enables the twig surface
  watchAssigneeId: string; // poll twigs assigned to this user id (optional)
  watchProjectId: string; // poll twigs under this project/subtree (optional)
  sessionToken: string; // session bearer — enables the chat surface
  aiConnectionId: string; // reply AS this ai_connection (else reply as the session user)
  chatIds: string[]; // explicit chats to watch (empty → discover all active chats)
  pollIntervalMs: number;
}

interface ChatEvent {
  id: string;
  chat_twig_id: string;
  seq: number;
  client_msg_id: string | null;
  sender_user_id: string | null;
  sender_ai_connection_id: string | null;
  body: string;
  message_type: string;
  is_deleted: boolean;
  created_at: string;
}

interface TwigRow {
  id: string;
  content: string;
  status: string | null;
  priority: string | null;
  due_date: string | null;
  due_time: string | null;
  completed_at: string | null;
  assignee_name: string | null;
  updated_at: string;
}

interface PersistedState {
  processedTwigIds: string[];
  chatCursors: Record<string, number>;
}

/** IANA timezone the twig due_date/due_time are authored in (Heath's local). */
export const AGENT_TZ = 'Europe/Brussels';

/**
 * The UTC instant (ms) of a wall-clock `YYYY-MM-DD HH:MM` read in timezone `tz`.
 * Handles DST correctly by measuring the tz offset at that instant instead of
 * hardcoding it. Example: 2026-07-24 07:30 Europe/Brussels (CEST, +2) → the ms
 * for 2026-07-24T05:30:00Z.
 */
export function wallClockToUtcMs(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  tz: string = AGENT_TZ,
): number {
  const guessUtc = Date.UTC(y, mo - 1, d, h, mi, 0);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(
    dtf.formatToParts(new Date(guessUtc)).map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  // 'hour' can come back as '24' at midnight in some environments; normalize.
  const hh = p.hour === '24' ? 0 : Number(p.hour);
  const asTzMs = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    hh,
    Number(p.minute),
    Number(p.second),
  );
  const offset = asTzMs - guessUtc;
  return guessUtc - offset;
}

/**
 * Whether a twig is eligible for auto-delivery to the agent. Three primitives,
 * all of which must hold. Exported so the verification script applies the
 * identical rule to live Twiglit data.
 *
 *  1. NOT completed. The `completed` flag is a first-class Twiglit primitive and
 *     is respected directly: a completed (or done/cancelled) twig is never work,
 *     even if some other field still says `todo`.
 *  2. Has a due date. The due date+time IS the fire trigger. Undated twigs (the
 *     hand-off children the agent creates for Heath to finish by hand) never
 *     auto-run.
 *  3. The due moment has arrived. The twig fires at its due date AND time, read
 *     in Heath's timezone (AGENT_TZ), not at UTC midnight — a twig due 07:30 does
 *     not run at 02:00 local. A twig with no due_time defaults to 00:00 local. A
 *     future occurrence (the next one a daily recurrence just spawned) is skipped
 *     until its own due moment, so a recurring twig fires exactly once per day.
 */
export function isDueForDelivery(
  twig: {
    due_date: string | null;
    due_time?: string | null;
    completed_at?: string | null;
    status?: string | null;
  },
  now: Date = new Date(),
): boolean {
  if (twig.completed_at) return false;
  if (twig.status === 'done' || twig.status === 'cancelled') return false;
  if (!twig.due_date) return false;
  const [y, mo, d] = twig.due_date.slice(0, 10).split('-').map(Number);
  const [h, mi] = (twig.due_time ?? '00:00').slice(0, 5).split(':').map(Number);
  const fireAtMs = wallClockToUtcMs(y, mo, d, h, mi, AGENT_TZ);
  return now.getTime() >= fireAtMs;
}

export class TwiglitChannel implements Channel {
  name = 'twiglit';

  private cfg: TwiglitConfig;
  private opts: ChannelOpts;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  private processedTwigIds = new Set<string>();
  private chatCursors = new Map<string, number>();
  /** client_msg_ids we generated for our own chat replies, to skip on read-back. */
  private sentClientMsgIds = new Set<string>();
  /** chat_twig_id → { userId → display_name } for sender-name resolution. */
  private chatParticipants = new Map<string, Map<string, string>>();
  private statePath: string;

  constructor(cfg: TwiglitConfig, opts: ChannelOpts) {
    this.cfg = cfg;
    this.opts = opts;
    this.statePath = path.join(STORE_DIR, 'twiglit-state.json');
    this.loadState();
  }

  private get chatEnabled(): boolean {
    return this.cfg.sessionToken.length > 0;
  }

  private get twigEnabled(): boolean {
    return (
      this.cfg.apiKey.length > 0 &&
      (this.cfg.watchAssigneeId.length > 0 ||
        this.cfg.watchProjectId.length > 0)
    );
  }

  async connect(): Promise<void> {
    if (this.chatEnabled) {
      // Discover + register chats up front so name resolution is warm and the
      // message loop knows the JIDs before the first message arrives.
      try {
        await this.refreshChats();
      } catch (err) {
        logger.warn({ err }, 'Twiglit: initial chat discovery failed');
      }
    }
    this.running = true;
    logger.info(
      {
        baseUrl: this.cfg.baseUrl,
        chat: this.chatEnabled,
        twig: this.twigEnabled,
        botIdentity: this.cfg.aiConnectionId ? 'ai_connection' : 'session-user',
      },
      'Twiglit channel connected (polling)',
    );
    console.log(
      `\n  Twiglit: ${this.cfg.baseUrl} — chat:${this.chatEnabled ? 'on' : 'off'} twig:${this.twigEnabled ? 'on' : 'off'}\n`,
    );
    this.scheduleNextPoll();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    try {
      if (jid.startsWith(CHAT_PREFIX)) {
        await this.postChatReply(jid.slice(CHAT_PREFIX.length), text);
      } else if (jid.startsWith(TWIG_PREFIX)) {
        await this.postTwigComment(jid.slice(TWIG_PREFIX.length), text);
      } else {
        logger.warn({ jid }, 'Twiglit: unroutable JID');
      }
    } catch (err) {
      logger.error({ jid, err }, 'Twiglit: failed to send message');
    }
  }

  isConnected(): boolean {
    return this.running;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('twiglit:');
  }

  async disconnect(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info('Twiglit channel stopped');
  }

  // --- Polling ---------------------------------------------------------------

  private scheduleNextPoll(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.poll()
        .catch((err) => logger.error({ err }, 'Twiglit poll error'))
        .finally(() => this.scheduleNextPoll());
    }, this.cfg.pollIntervalMs);
  }

  private async poll(): Promise<void> {
    if (this.twigEnabled) await this.pollTwigs();
    if (this.chatEnabled) {
      // Re-run discovery every cycle so a chat the bot was just added to
      // (in-app) is picked up without a restart — the add IS the setup.
      try {
        await this.refreshChats();
      } catch (err) {
        logger.warn({ err }, 'Twiglit: chat discovery refresh failed');
      }
      await this.pollChats();
    }
  }

  private async pollTwigs(): Promise<void> {
    const params = new URLSearchParams({ status: 'todo', limit: '100' });
    if (this.cfg.watchAssigneeId)
      params.set('assignee_id', this.cfg.watchAssigneeId);
    if (this.cfg.watchProjectId)
      params.set('project_id', this.cfg.watchProjectId);
    const res = await this.apiV1<{ data: TwigRow[] }>(
      `/api/v1/twigs?${params.toString()}`,
    );
    for (const twig of res.data) {
      // Never treat the watched project/container twig itself as a work item.
      if (twig.id === this.cfg.watchProjectId) continue;
      if (this.processedTwigIds.has(twig.id)) continue;
      // Only auto-run twigs that are due today or overdue. This is the guard that
      // stops the recurrence loop: when a daily recurring twig is completed,
      // Twiglit immediately spawns the NEXT occurrence dated +1 day. Without this
      // check pollTwigs would deliver that future occurrence the same minute it is
      // created, burning the entire series in one sitting and re-firing every
      // application (the duplicate-applications incident). Skipping is deliberate
      // and NON-permanent: a future occurrence is re-evaluated every poll and picked
      // up once its own day arrives, so each daily twig runs exactly once per day.
      // Undated twigs are also skipped — those are the hand-off child twigs the agent
      // creates for Heath to finish by hand, which must never auto-execute.
      if (!isDueForDelivery(twig)) continue;
      this.processedTwigIds.add(twig.id);
      this.saveState();
      await this.deliverTwig(twig);
    }
  }

  private async deliverTwig(twig: TwigRow): Promise<void> {
    const jid = `${TWIG_PREFIX}${twig.id}`;
    const now = new Date().toISOString();

    // Track is decided by the twig title (the only reliable signal — the longer
    // description does not always reach the agent). A "blitz" twig is the broad
    // non-engineering exec sweep and runs in the `blitz` workspace; everything
    // else is the FDE/engineering track in `fde`. Each workspace is a distinct
    // Synology-synced folder with its own CV and rules.
    const folder = /\bblitz\b/i.test(twig.content) ? 'blitz' : 'fde';

    // The twigs feed omits the description; fetch the full twig so the run gets
    // the actual spec (sites, filters, instructions), not just the title. Also
    // capture owner_id so hand-off child twigs can be assigned back to Heath.
    let description = '';
    let ownerId = '';
    try {
      const full = await this.apiV1<{
        description?: string;
        owner_id?: string;
        data?: { description?: string; owner_id?: string };
      }>(`/api/v1/twigs/${twig.id}`);
      description = (full.description ?? full.data?.description ?? '').trim();
      ownerId = (full.owner_id ?? full.data?.owner_id ?? '').trim();
    } catch (err) {
      logger.warn(
        { twigId: twig.id, err },
        'Twiglit: could not fetch twig description',
      );
    }

    // Register the twig as its own group so the message loop processes it and
    // the agent's reply routes back to THIS twig's comments (send_message is
    // pinned to the group's own JID).
    this.opts.ensureGroup(jid, {
      name: `Twig: ${twig.content.slice(0, 40)}`,
      folder,
      trigger: '',
      added_at: now,
      requiresTrigger: false,
      isMain: false,
    });

    const lines = [
      'A Twiglit twig has been assigned to you. Do the work it describes, then report back ON THIS TWIG using the Twiglit MCP (mcp__twiglit__*).',
      '',
      `twig_id: ${twig.id}`,
      `title: ${twig.content}`,
      `status: ${twig.status ?? 'todo'}`,
    ];
    if (twig.priority) lines.push(`priority: ${twig.priority}`);
    if (twig.due_date) lines.push(`due: ${twig.due_date}`);
    if (twig.assignee_name) lines.push(`assignee: ${twig.assignee_name}`);
    lines.push(`link: ${this.cfg.baseUrl}/twig/${twig.id}`);
    if (description) lines.push('', 'description:', description);
    lines.push(
      '',
      'When the work is done, on this twig (twig_id above), via the Twiglit MCP:',
      '- Attach the deliverables (tailored CV and cover+cases PDF) with upload_twig_asset.',
      '- For each role Heath must finish by hand (a login/CAPTCHA-walled apply, or a decision he owns), create ONE child twig with create_twig:',
      '    • parent_id = this twig',
      `    • content = the job as "Company - Role" and NOTHING else (e.g. "Databricks - AI Engineer FDE"). No "HAND-OFF", no "submit by hand", no blocker, no em dash. Just Company - Role.`,
      ownerId
        ? `    • assignee_id = ${ownerId} (this is Heath — REQUIRED so the twig lands in his list; a child twig with no assignee is invisible to him).`
        : `    • assignee_id = Heath's user id — call mcp__twiglit__get_me and pass its id (REQUIRED so the twig lands in his list; an unassigned child twig is invisible to him).`,
      '    • description = the apply URL, the job folder path where the files live (applications/<company-role>/, or applications/<company>/<company-role>/ if that company has multiple roles), and any blocker/context (reCAPTCHA, Ashby, login wall). Details go here, never in the title.',
      '    • then attach the prepared CV + cover PDF to that child twig with upload_twig_asset.',
      '- Mark this twig done with update_twig (status=done). REQUIRED: the recurrence only spawns the next run when this twig is completed.',
      'Your final reply message is auto-posted as a comment on this twig, so make it a summary of exactly what you applied to (which roles and where).',
    );

    this.opts.onChatMetadata(
      jid,
      now,
      `Twig: ${twig.content.slice(0, 40)}`,
      'twiglit',
      false,
    );
    this.opts.onMessage(jid, {
      id: `twig_${twig.id}`,
      chat_jid: jid,
      sender: 'twiglit',
      sender_name: 'Twiglit',
      content: lines.join('\n'),
      timestamp: now,
      is_from_me: false,
    });
    logger.info({ twigId: twig.id }, 'Twiglit: delivered twig work item');
  }

  private async pollChats(): Promise<void> {
    const chatIds = this.cfg.chatIds.length
      ? this.cfg.chatIds
      : [...this.chatParticipants.keys()];
    for (const chatId of chatIds) {
      try {
        await this.pollOneChat(chatId);
      } catch (err) {
        logger.warn({ chatId, err }, 'Twiglit: chat poll failed');
      }
    }
  }

  private async pollOneChat(chatId: string): Promise<void> {
    const since = this.chatCursors.get(chatId) ?? 0;
    const res = await this.chatApi<{ events: ChatEvent[] }>(
      `/api/chats/${chatId}/messages?since_seq=${since}&limit=200`,
    );
    let maxSeq = since;
    for (const ev of res.events) {
      if (ev.seq > maxSeq) maxSeq = ev.seq;
      if (!this.shouldDeliverChat(ev)) continue;
      this.deliverChat(chatId, ev);
    }
    if (maxSeq !== since) {
      this.chatCursors.set(chatId, maxSeq);
      this.saveState();
    }
  }

  private shouldDeliverChat(ev: ChatEvent): boolean {
    if (ev.is_deleted) return false;
    if (!ev.body || !ev.body.trim()) return false;
    if (SKIP_MESSAGE_TYPES.has(ev.message_type)) return false;
    // Skip our own replies. Bot mode: match ai_connection. User mode: match the
    // client_msg_id we minted when sending.
    if (this.cfg.aiConnectionId) {
      if (ev.sender_ai_connection_id === this.cfg.aiConnectionId) return false;
    } else if (
      ev.client_msg_id &&
      this.sentClientMsgIds.has(ev.client_msg_id)
    ) {
      return false;
    }
    return true;
  }

  private deliverChat(chatId: string, ev: ChatEvent): void {
    const jid = `${CHAT_PREFIX}${chatId}`;
    const now = new Date().toISOString();
    const names = this.chatParticipants.get(chatId);
    const senderName =
      (ev.sender_user_id && names?.get(ev.sender_user_id)) ||
      (ev.sender_ai_connection_id ? 'AI' : 'Twiglit user');

    this.opts.onMessage(jid, {
      id: ev.id,
      chat_jid: jid,
      sender: ev.sender_user_id ?? ev.sender_ai_connection_id ?? 'twiglit',
      sender_name: senderName,
      content: ev.body,
      timestamp: now,
      is_from_me: false,
    });
    logger.info({ chatId, seq: ev.seq }, 'Twiglit: delivered chat message');
  }

  /** Discover active chats, register them as groups, and cache participant names. */
  private async refreshChats(): Promise<void> {
    // Bot keys hit the discovery read (title + last_seq, only the chats the
    // connection is exposed to); a session token returns the human shape
    // (content + other_party). Accept either.
    const res = await this.chatApi<{
      chats: Array<{
        id: string;
        content?: string;
        title?: string;
        other_party?: Array<{ id: string; display_name: string }>;
      }>;
    }>(`/api/chats?status=active`);

    const watch = this.cfg.chatIds;
    for (const chat of res.chats) {
      if (watch.length && !watch.includes(chat.id)) continue;
      const name = chat.title || chat.content || 'Twiglit chat';
      const names = new Map<string, string>();
      for (const p of chat.other_party ?? []) names.set(p.id, p.display_name);
      this.chatParticipants.set(chat.id, names);

      const jid = `${CHAT_PREFIX}${chat.id}`;
      this.opts.ensureGroup(jid, {
        name,
        folder: 'twiglit-chat',
        trigger: '',
        added_at: new Date().toISOString(),
        requiresTrigger: false,
        isMain: false,
      });
      this.opts.onChatMetadata(
        jid,
        new Date().toISOString(),
        name,
        'twiglit',
        false,
      );
    }
  }

  // --- Outbound --------------------------------------------------------------

  private async postChatReply(chatId: string, text: string): Promise<void> {
    const clientMsgId = crypto.randomUUID();
    this.sentClientMsgIds.add(clientMsgId);
    // Bound the dedup set so it can't grow without limit.
    if (this.sentClientMsgIds.size > 1000) {
      const first = this.sentClientMsgIds.values().next().value;
      if (first) this.sentClientMsgIds.delete(first);
    }
    const body: Record<string, unknown> = {
      client_msg_id: clientMsgId,
      body: text,
      message_type: 'text',
    };
    if (this.cfg.aiConnectionId) {
      body.sender_ai_connection_id = this.cfg.aiConnectionId;
    }
    await this.chatApi(`/api/chats/${chatId}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    logger.info({ chatId, length: text.length }, 'Twiglit: chat reply sent');
  }

  private async postTwigComment(twigId: string, text: string): Promise<void> {
    await this.apiV1(`/api/v1/twigs/${twigId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    logger.info(
      { twigId, length: text.length },
      'Twiglit: twig comment posted',
    );
  }

  // --- HTTP helpers ----------------------------------------------------------

  /** `/api/v1/*` — `twg_` API-key auth. */
  private apiV1<T = unknown>(
    pathAndQuery: string,
    init: { method?: string; body?: string } = {},
  ): Promise<T> {
    return this.request<T>(pathAndQuery, {
      ...init,
      headers: { Authorization: `Bearer ${this.cfg.apiKey}` },
    });
  }

  /** `/api/chats/*` — session-token auth. */
  private chatApi<T = unknown>(
    pathAndQuery: string,
    init: { method?: string; body?: string } = {},
  ): Promise<T> {
    return this.request<T>(pathAndQuery, {
      ...init,
      headers: { Authorization: `Bearer ${this.cfg.sessionToken}` },
    });
  }

  private async request<T>(
    pathAndQuery: string,
    init: { method?: string; body?: string; headers: Record<string, string> },
  ): Promise<T> {
    const url = `${this.cfg.baseUrl}${pathAndQuery}`;
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...init.headers,
      },
      body: init.body,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Twiglit ${init.method ?? 'GET'} ${pathAndQuery} → ${res.status} ${detail.slice(0, 300)}`,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // --- State persistence -----------------------------------------------------

  private loadState(): void {
    try {
      const raw = fs.readFileSync(this.statePath, 'utf-8');
      const state = JSON.parse(raw) as PersistedState;
      this.processedTwigIds = new Set(state.processedTwigIds ?? []);
      this.chatCursors = new Map(Object.entries(state.chatCursors ?? {}));
    } catch {
      // No prior state — start fresh.
    }
  }

  private saveState(): void {
    const state: PersistedState = {
      processedTwigIds: [...this.processedTwigIds],
      chatCursors: Object.fromEntries(this.chatCursors),
    };
    try {
      fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2));
    } catch (err) {
      logger.warn({ err }, 'Twiglit: failed to persist state');
    }
  }
}

// Self-register
registerChannel('twiglit', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'TWIGLIT_BASE_URL',
    'TWIGLIT_API_KEY',
    'TWIGLIT_WATCH_ASSIGNEE_ID',
    'TWIGLIT_WATCH_PROJECT_ID',
    'TWIGLIT_SESSION_TOKEN',
    'TWIGLIT_AI_CONNECTION_ID',
    'TWIGLIT_CHAT_IDS',
    'TWIGLIT_POLL_INTERVAL_MS',
  ]);
  const get = (k: string): string =>
    (process.env[k] || envVars[k] || '').trim();

  const cfg: TwiglitConfig = {
    baseUrl: get('TWIGLIT_BASE_URL') || 'https://app.twigl.it',
    apiKey: get('TWIGLIT_API_KEY'),
    watchAssigneeId: get('TWIGLIT_WATCH_ASSIGNEE_ID'),
    watchProjectId: get('TWIGLIT_WATCH_PROJECT_ID'),
    sessionToken: get('TWIGLIT_SESSION_TOKEN'),
    aiConnectionId: get('TWIGLIT_AI_CONNECTION_ID'),
    chatIds: get('TWIGLIT_CHAT_IDS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    pollIntervalMs: parseInt(get('TWIGLIT_POLL_INTERVAL_MS') || '5000', 10),
  };

  const chatEnabled = cfg.sessionToken.length > 0;
  const twigEnabled =
    cfg.apiKey.length > 0 &&
    (cfg.watchAssigneeId.length > 0 || cfg.watchProjectId.length > 0);
  if (!chatEnabled && !twigEnabled) {
    logger.warn(
      'Twiglit: not configured (need TWIGLIT_SESSION_TOKEN for chat, or TWIGLIT_API_KEY + TWIGLIT_WATCH_ASSIGNEE_ID/TWIGLIT_WATCH_PROJECT_ID for twigs) — skipping',
    );
    return null;
  }
  return new TwiglitChannel(cfg, opts);
});
