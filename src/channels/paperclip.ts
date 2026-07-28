import http from 'http';
import https from 'https';
import crypto from 'crypto';

import { ASSISTANT_NAME } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel } from '../types.js';

// --- Types matching Paperclip's actual HTTP adapter payload ---
// Source: paperclip/server/src/adapters/http/execute.ts
//   const body = { ...payloadTemplate, agentId: agent.id, runId, context };

interface PaperclipWebhookPayload {
  agentId: string;
  runId: string;
  context: PaperclipContext;
  // Any additional fields from payloadTemplate (companyId, custom fields, etc.)
  [key: string]: unknown;
}

/** Context built by Paperclip's heartbeat service (enrichWakeContextSnapshot). */
interface PaperclipContext {
  // Wake reason & source
  wakeReason?: string; // "task_assigned" | "heartbeat" | "manual" | "issue_comment_mentioned" | etc.
  wakeSource?: string; // "timer" | "assignment" | "on_demand" | "automation"
  wakeTriggerDetail?: string; // "manual" | "ping" | "callback" | "system"

  // Issue / task that triggered the wake
  issueId?: string | null;
  taskId?: string | null;
  taskKey?: string | null;
  projectId?: string | null;
  projectWorkspaceId?: string | null;

  // Comment tracking
  commentId?: string | null;
  wakeCommentId?: string | null;

  // Approval resolution
  approvalId?: string | null;
  approvalStatus?: string | null;

  // Workspace info
  paperclipWorkspace?: {
    cwd: string;
    source: string;
    mode?: string;
    strategy?: string;
    projectId?: string | null;
    workspaceId?: string | null;
    repoUrl?: string | null;
    repoRef?: string | null;
    branchName?: string | null;
    worktreePath?: string | null;
    agentHome?: string;
  };

  // Session management
  paperclipSessionHandoffMarkdown?: string;
  paperclipSessionRotationReason?: string;
  paperclipPreviousSessionId?: string;
  resumeSessionDisplayId?: string;
  resumeFromRunId?: string;
  forceFreshSession?: boolean;

  // Runtime services
  paperclipRuntimeServices?: Array<Record<string, unknown>>;
  paperclipRuntimePrimaryUrl?: string | null;

  [key: string]: unknown;
}

/** Callback payload POSTed to Paperclip when agent finishes. */
interface PaperclipCallbackPayload {
  status: 'succeeded' | 'failed';
  result?: string;
  errorMessage?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  costUsd?: number;
  model?: string;
  provider?: string;
}

// Track active runs for response routing
const activeRuns = new Map<
  string,
  { chatJid: string; agentId: string; startedAt: number }
>();

export class PaperclipChannel implements Channel {
  name = 'paperclip';

  private server: http.Server | null = null;
  private opts: ChannelOpts;
  private port: number;
  private webhookSecret: string;
  private paperclipApiUrl: string;
  private paperclipApiKey: string;

  constructor(
    port: number,
    webhookSecret: string,
    paperclipApiUrl: string,
    paperclipApiKey: string,
    opts: ChannelOpts,
  ) {
    this.port = port;
    this.webhookSecret = webhookSecret;
    this.paperclipApiUrl = paperclipApiUrl;
    this.paperclipApiKey = paperclipApiKey;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    return new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, () => {
        logger.info(
          { port: this.port, paperclipApi: this.paperclipApiUrl },
          'Paperclip webhook server listening',
        );
        console.log(
          `\n  Paperclip webhook: http://localhost:${this.port}/invoke`,
        );
        console.log(`  Paperclip API:     ${this.paperclipApiUrl}`);
        console.log(`  Endpoints: POST /invoke, GET /health\n`);
        resolve();
      });
      this.server!.on('error', (err) => {
        logger.error({ err }, 'Paperclip webhook server failed to start');
        reject(err);
      });
    });
  }

  /**
   * Called by NanoClaw when the agent produces output.
   * Posts the result back to Paperclip's heartbeat-run callback endpoint.
   */
  async sendMessage(jid: string, text: string): Promise<void> {
    const runId = jid.replace(/^paperclip:/, '');
    const run = activeRuns.get(runId);

    if (!run) {
      logger.warn({ runId }, 'Paperclip run not found for response');
      return;
    }

    try {
      await this.postCallback(runId, {
        status: 'succeeded',
        result: text,
        model: 'claude-opus-4-6',
        provider: 'anthropic',
      });
      logger.info({ runId, length: text.length }, 'Paperclip callback sent');
    } catch (err) {
      logger.error({ runId, err }, 'Failed to send Paperclip callback');
    }
  }

  isConnected(): boolean {
    return this.server !== null && this.server.listening;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('paperclip:');
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      return new Promise<void>((resolve) => {
        this.server!.close(() => {
          this.server = null;
          logger.info('Paperclip webhook server stopped');
          resolve();
        });
      });
    }
  }

  // --- HTTP handling ---

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers':
          'Content-Type, Authorization, X-Webhook-Secret, X-Paperclip-Run-Id',
      });
      res.end();
      return;
    }

    if (req.url === '/health' && req.method === 'GET') {
      this.sendJson(res, 200, {
        status: 'ok',
        channel: 'paperclip',
        activeRuns: activeRuns.size,
      });
      return;
    }

    if (req.method !== 'POST') {
      this.sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    this.readBody(req, (err, body) => {
      if (err) {
        this.sendJson(res, 400, { error: 'Invalid request body' });
        return;
      }

      if (this.webhookSecret && !this.verifySecret(req)) {
        this.sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        this.sendJson(res, 400, { error: 'Invalid JSON' });
        return;
      }

      if (req.url === '/invoke') {
        this.handleInvoke(payload as PaperclipWebhookPayload, res);
      } else {
        this.sendJson(res, 404, {
          error: 'Not found. Use POST /invoke or GET /health',
        });
      }
    });
  }

  private handleInvoke(
    payload: PaperclipWebhookPayload,
    res: http.ServerResponse,
  ): void {
    if (!payload.runId || !payload.agentId) {
      this.sendJson(res, 400, {
        error: 'Missing required fields: runId, agentId',
      });
      return;
    }

    const ctx = payload.context || {};
    const chatJid = `paperclip:${payload.runId}`;
    const timestamp = new Date().toISOString();
    const wakeReason = ctx.wakeReason || 'manual';
    const wakeSource = ctx.wakeSource || 'on_demand';

    // Track this run
    activeRuns.set(payload.runId, {
      chatJid,
      agentId: payload.agentId,
      startedAt: Date.now(),
    });

    // Build agent prompt with the wake context.
    // The agent's CLAUDE.md contains the Paperclip heartbeat protocol
    // (fetch tasks, checkout, execute, update). We provide the context
    // so it knows why it woke up and what to work on.

    const wakeBlock: string[] = [
      '<paperclip-wake>',
      `  <runId>${payload.runId}</runId>`,
      `  <agentId>${payload.agentId}</agentId>`,
      `  <wakeReason>${wakeReason}</wakeReason>`,
      `  <wakeSource>${wakeSource}</wakeSource>`,
    ];

    if (ctx.issueId) {
      wakeBlock.push(`  <issueId>${ctx.issueId}</issueId>`);
    }
    if (ctx.taskId && ctx.taskId !== ctx.issueId) {
      wakeBlock.push(`  <taskId>${ctx.taskId}</taskId>`);
    }
    if (ctx.wakeCommentId) {
      wakeBlock.push(`  <wakeCommentId>${ctx.wakeCommentId}</wakeCommentId>`);
    }
    if (ctx.approvalId) {
      wakeBlock.push(`  <approvalId>${ctx.approvalId}</approvalId>`);
      wakeBlock.push(
        `  <approvalStatus>${ctx.approvalStatus || 'unknown'}</approvalStatus>`,
      );
    }
    if (ctx.projectId) {
      wakeBlock.push(`  <projectId>${ctx.projectId}</projectId>`);
    }
    if (ctx.paperclipWorkspace) {
      const ws = ctx.paperclipWorkspace;
      wakeBlock.push(`  <workspace cwd="${ws.cwd}" source="${ws.source}" />`);
    }
    if (ctx.paperclipSessionHandoffMarkdown) {
      wakeBlock.push(
        `  <sessionHandoff>${ctx.paperclipSessionHandoffMarkdown}</sessionHandoff>`,
      );
    }

    wakeBlock.push('</paperclip-wake>');

    // Paperclip API credentials for the agent to call back into Paperclip.
    // companyId may come from payloadTemplate or we read it from env.
    const companyId = (payload as Record<string, unknown>).companyId || '';

    const apiBlock = [
      '<paperclip-api>',
      `  <url>${this.paperclipApiUrl}</url>`,
      `  <agentId>${payload.agentId}</agentId>`,
      ...(companyId ? [`  <companyId>${companyId}</companyId>`] : []),
      `  <runId>${payload.runId}</runId>`,
      '</paperclip-api>',
    ];

    const content = `@${ASSISTANT_NAME} Paperclip heartbeat wake.\n\n${wakeBlock.join('\n')}\n\n${apiBlock.join('\n')}`;

    // Store chat metadata
    this.opts.onChatMetadata(
      chatJid,
      timestamp,
      `Paperclip: ${payload.agentId}`,
      'paperclip',
      false,
    );

    // Deliver to NanoClaw pipeline
    this.opts.onMessage(chatJid, {
      id: `pc_${payload.runId}`,
      chat_jid: chatJid,
      sender: 'paperclip',
      sender_name: 'Paperclip',
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      {
        runId: payload.runId,
        agentId: payload.agentId,
        wakeReason,
        wakeSource,
        issueId: ctx.issueId,
      },
      'Paperclip wake received',
    );

    // Return 202 immediately — Paperclip's HTTP adapter only checks for non-error status.
    // Agent results are delivered via the callback endpoint.
    this.sendJson(res, 202, {
      status: 'accepted',
      executionId: payload.runId,
    });
  }

  // --- Paperclip callback ---

  /**
   * POST results to Paperclip: /api/heartbeat-runs/{runId}/callback
   */
  private async postCallback(
    runId: string,
    payload: PaperclipCallbackPayload,
  ): Promise<void> {
    const callbackUrl = `${this.paperclipApiUrl}/api/heartbeat-runs/${runId}/callback`;
    const body = JSON.stringify(payload);
    const parsed = new URL(callbackUrl);
    const transport = parsed.protocol === 'https:' ? https : http;

    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Paperclip-Run-Id': runId,
        ...(this.paperclipApiKey
          ? { Authorization: `Bearer ${this.paperclipApiKey}` }
          : {}),
      },
    };

    return new Promise<void>((resolve, reject) => {
      const req = transport.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            activeRuns.delete(runId);
            resolve();
          } else {
            reject(
              new Error(
                `Paperclip callback returned ${res.statusCode}: ${data}`,
              ),
            );
          }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // --- Helpers ---

  private verifySecret(req: http.IncomingMessage): boolean {
    const provided =
      req.headers['x-webhook-secret'] ||
      req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    if (!provided) return false;
    const a = Buffer.from(this.webhookSecret);
    const b = Buffer.from(String(provided));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  private readBody(
    req: http.IncomingMessage,
    cb: (err: Error | null, body: string) => void,
  ): void {
    let body = '';
    const maxSize = 1_048_576; // 1MB
    req.on('data', (chunk: Buffer) => {
      body += chunk;
      if (body.length > maxSize) {
        req.destroy();
        cb(new Error('Body too large'), '');
      }
    });
    req.on('end', () => cb(null, body));
    req.on('error', (err) => cb(err, ''));
  }

  private sendJson(
    res: http.ServerResponse,
    status: number,
    data: unknown,
  ): void {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
  }
}

// Cleanup stale runs every 30 minutes
setInterval(() => {
  const staleThreshold = Date.now() - 3_600_000;
  for (const [runId, run] of activeRuns) {
    if (run.startedAt < staleThreshold) {
      activeRuns.delete(runId);
      logger.debug({ runId }, 'Cleaned up stale Paperclip run');
    }
  }
}, 1_800_000);

// Self-register
registerChannel('paperclip', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'PAPERCLIP_WEBHOOK_PORT',
    'PAPERCLIP_WEBHOOK_SECRET',
    'PAPERCLIP_API_URL',
    'PAPERCLIP_API_KEY',
  ]);

  const port = parseInt(
    process.env.PAPERCLIP_WEBHOOK_PORT || envVars.PAPERCLIP_WEBHOOK_PORT || '',
    10,
  );
  if (!port) {
    logger.warn('Paperclip: PAPERCLIP_WEBHOOK_PORT not set');
    return null;
  }

  const apiUrl =
    process.env.PAPERCLIP_API_URL || envVars.PAPERCLIP_API_URL || '';
  if (!apiUrl) {
    logger.warn('Paperclip: PAPERCLIP_API_URL not set');
    return null;
  }

  const secret =
    process.env.PAPERCLIP_WEBHOOK_SECRET ||
    envVars.PAPERCLIP_WEBHOOK_SECRET ||
    '';
  const apiKey =
    process.env.PAPERCLIP_API_KEY || envVars.PAPERCLIP_API_KEY || '';

  return new PaperclipChannel(port, secret, apiUrl, apiKey, opts);
});
