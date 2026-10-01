const MAX_PARTICIPANTS = 19;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "skyhigh-radio-signaling" });
    }

    if (url.pathname !== "/ws") {
      return new Response("SkyHigh Event Radio signaling service", {
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return jsonResponse({ error: "Use a WebSocket connection at /ws?channel=<frequency>." }, 426);
    }

    const channel = normaliseChannel(url.searchParams.get("channel") || "");
    if (!channel) return jsonResponse({ error: "A channel query parameter is required." }, 400);
    if (channel.length > 24) return jsonResponse({ error: "Channel names must be 24 characters or fewer." }, 400);

    const roomId = env.RADIO_ROOM.idFromName(channel);
    const room = env.RADIO_ROOM.get(roomId);
    return room.fetch(request);
  }
};

export class RadioRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket endpoint only.", { status: 426 });
    }

    if (this.ctx.getWebSockets().length >= MAX_PARTICIPANTS) {
      return jsonResponse({ error: `This frequency is full (${MAX_PARTICIPANTS} participants).` }, 503);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const peerId = crypto.randomUUID();

    this.ctx.acceptWebSocket(server, ["peerId", peerId]);
    const peers = this.getPeers();
    this.send(server, { type: "welcome", peerId, peers });
    this.broadcast({ type: "peer-joined", peerId }, server);

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(webSocket, message) {
    const sender = this.getPeerId(webSocket);
    if (!sender) {
      webSocket.close(1008, "Unknown peer.");
      return;
    }

    if (typeof message !== "string" || message.length > 200000) {
      this.send(webSocket, { type: "error", message: "Invalid signaling message." });
      return;
    }

    let parsed;
    try { parsed = JSON.parse(message); } catch {
      this.send(webSocket, { type: "error", message: "Signaling data must be JSON." });
      return;
    }

    if (parsed?.type !== "signal" || typeof parsed.target !== "string" || !parsed.data || typeof parsed.data.type !== "string") {
      this.send(webSocket, { type: "error", message: "Unsupported signaling message." });
      return;
    }

    const targetSocket = this.findSocketByPeerId(parsed.target);
    if (!targetSocket) {
      this.send(webSocket, { type: "error", message: "That participant has left the frequency." });
      return;
    }

    this.send(targetSocket, { type: "signal", from: sender, data: parsed.data });
  }

  webSocketClose(webSocket) {
    const peerId = this.getPeerId(webSocket);
    if (peerId) this.broadcast({ type: "peer-left", peerId });
  }

  webSocketError(webSocket) {
    const peerId = this.getPeerId(webSocket);
    if (peerId) this.broadcast({ type: "peer-left", peerId });
  }

  getPeers() {
    return this.ctx.getWebSockets().map((webSocket) => this.getPeerId(webSocket)).filter(Boolean);
  }

  getPeerId(webSocket) {
    const attachment = webSocket.deserializeAttachment();
    return Array.isArray(attachment) && attachment[0] === "peerId" ? attachment[1] : null;
  }

  findSocketByPeerId(peerId) {
    return this.ctx.getWebSockets().find((webSocket) => this.getPeerId(webSocket) === peerId);
  }

  broadcast(payload, exceptSocket = null) {
    for (const webSocket of this.ctx.getWebSockets()) {
      if (webSocket !== exceptSocket) this.send(webSocket, payload);
    }
  }

  send(webSocket, payload) {
    try { webSocket.send(JSON.stringify(payload)); } catch { /* close handlers notify remaining peers */ }
  }
}

function normaliseChannel(value) {
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store"
    }
  });
}
