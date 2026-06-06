import { readFileSync, existsSync } from "fs";
import { join as pathJoin } from "path";
import os from "os";
import type { ServerWebSocket } from "bun";
import { getBot } from "../botmanager.js";
import { chatBuffer, type ChatMessage, type ChannelInfo } from "../chatbuffer.js";

const DATA_DIR = pathJoin(process.cwd(), "data");

export interface ChatSendRequest {
  bot: string;
  channel: string;
  content: string;
  targetId?: string;
}

type WSData = { id: number };

export class ChatWebServer {
  private port: number;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private clients = new Set<ServerWebSocket<WSData>>();
  private nextClientId = 1;

  constructor(port: number = 4000) {
    this.port = port;
  }

  start(): void {
    const indexPath = pathJoin(import.meta.dir, "chat.html");
    const cssPath = pathJoin(import.meta.dir, "chat.css");

    this.server = Bun.serve<WSData>({
      hostname: "0.0.0.0",
      port: this.port,
      fetch: async (req) => {
        const url = new URL(req.url);

        if (url.pathname === "/ws") {
          const id = this.nextClientId++;
          const ok = this.server!.upgrade(req, { data: { id } });
          if (ok) {
            return undefined as unknown as Response;
          }
          return new Response("WebSocket upgrade failed", { status: 400 });
        }

        if (url.pathname === "/api/bots" && req.method === "GET") {
          return Response.json({ bots: chatBuffer.getBots() });
        }

        if (url.pathname === "/api/channels" && req.method === "GET") {
          const bot = url.searchParams.get("bot") || "";
          const channels = bot ? chatBuffer.getChannels(bot) : [];
          return Response.json({ channels });
        }

        if (url.pathname === "/api/messages" && req.method === "GET") {
          const bot = url.searchParams.get("bot") || "";
          const channel = url.searchParams.get("channel") || "";
          const limit = parseInt(url.searchParams.get("limit") || "200", 10);
          const offset = parseInt(url.searchParams.get("offset") || "0", 10);
          const messages = chatBuffer.getMessages({ bot, channel, limit, offset });
          return Response.json({ messages, count: chatBuffer.getMessageCount({ bot, channel }) });
        }

        if (url.pathname === "/api/send" && req.method === "POST") {
          const body = (await req.json()) as ChatSendRequest;
          const { bot, channel, content, targetId } = body;

          if (!bot || !channel || !content) {
            return Response.json({ error: "Missing bot, channel, or content" }, { status: 400 });
          }

          const botInstance = getBot(bot);
          if (!botInstance) {
            return Response.json({ error: `Bot ${bot} not found` }, { status: 404 });
          }

          try {
            const chatBody: Record<string, unknown> = { channel, content };
            if (channel === "private") {
              if (!targetId) {
                return Response.json({ error: "targetId is required for private messages" }, { status: 400 });
              }
              chatBody.target_id = targetId;
            }

            const result = await botInstance.exec("chat", chatBody);

            if (result.error) {
              return Response.json({ error: result.error.message || "Chat failed" }, { status: 500 });
            }

            const sentMsg: ChatMessage = {
              botUsername: bot,
              channel,
              sender: bot,
              content,
              timestamp: Date.now(),
              direction: "out",
              ...(targetId ? { targetId } : {}),
            };
            chatBuffer.addMessage(sentMsg);

            this.broadcast({ type: "new_message", message: sentMsg });

            return Response.json({ ok: true, message: "Message sent" });
          } catch (err) {
            return Response.json(
              { error: err instanceof Error ? err.message : String(err) },
              { status: 500 }
            );
          }
        }

        if (url.pathname === "/chat.css") {
          if (existsSync(cssPath)) {
            return new Response(readFileSync(cssPath, "utf-8"), {
              headers: {
                "Content-Type": "text/css; charset=utf-8",
                "Cache-Control": "no-store",
              },
            });
          }
          return new Response("Not found", { status: 404 });
        }

        if (existsSync(indexPath)) {
          return new Response(readFileSync(indexPath, "utf-8"), {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        }

        return new Response("Chat UI not found", { status: 404 });
      },
      websocket: {
        open: (ws: ServerWebSocket<WSData>) => {
          this.clients.add(ws);
        },
        message: (_ws: ServerWebSocket<WSData>, msg: string | Buffer) => {
          try {
            const raw = JSON.parse(typeof msg === "string" ? msg : msg.toString());
            if (raw.type === "ping") {
              _ws.send(JSON.stringify({ type: "pong" }));
            }
          } catch {
            // ignore malformed messages
          }
        },
        close: (ws: ServerWebSocket<WSData>) => {
          this.clients.delete(ws);
        },
      },
    });

    const lanIp = this.getLocalIp() || "localhost";
    console.log(`Chat UI: http://localhost:${this.port}`);
    console.log(`Chat UI (LAN): http://${lanIp}:${this.port}`);
  }

  stop(): void {
    this.server?.stop();
  }

  broadcast(data: unknown): void {
    const msg = JSON.stringify(data);
    for (const ws of this.clients) {
      try {
        ws.send(msg);
      } catch {
        this.clients.delete(ws);
      }
    }
  }

  private getLocalIp(): string | null {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      const addrs = interfaces[name];
      if (!addrs) continue;
      for (const iface of addrs) {
        if (iface.family === "IPv4" && !iface.internal) {
          return iface.address;
        }
      }
    }
    return null;
  }
}
