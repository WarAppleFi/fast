export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Map(); // id -> websocket
    this.positions = new Map(); // id -> {x,y,id}
    this.heartbeat = null;
  }

  async fetch(request) {
    // Only accept WebSocket upgrade requests
    if (request.headers.get('upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // assign a short id/hash for this connection
    const id = crypto.randomUUID().slice(0, 8);

    server.accept();
    this.clients.set(id, server);
    this.positions.set(id, { x: Math.random() * 800, y: Math.random() * 600, id });

    server.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'move') {
          const p = this.positions.get(id) || { x: 0, y: 0, id };
          if (typeof msg.x === 'number') p.x = msg.x;
          if (typeof msg.y === 'number') p.y = msg.y;
          if (typeof msg.dx === 'number') p.x += msg.dx;
          if (typeof msg.dy === 'number') p.y += msg.dy;
          this.positions.set(id, p);
          this.broadcast({ type: 'update', id, x: p.x, y: p.y }, id);
        } else if (msg.type === 'ping') {
          server.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (e) {
        // ignore malformed messages
      }
    });

    server.addEventListener('close', () => {
      this.clients.delete(id);
      this.positions.delete(id);
      this.broadcast({ type: 'leave', id });
      if (this.clients.size === 0 && this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
      }
    });

    // Send welcome with current players
    server.send(JSON.stringify({ type: 'welcome', id, players: Array.from(this.positions.values()) }));
    this.broadcast({ type: 'join', id, x: this.positions.get(id).x, y: this.positions.get(id).y }, id);

    if (!this.heartbeat) {
      // periodic authoritative state broadcast
      this.heartbeat = setInterval(() => {
        try {
          this.broadcast({ type: 'state', players: Array.from(this.positions.values()) });
        } catch (e) {}
      }, 100);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(obj, exceptId) {
    const text = JSON.stringify(obj);
    for (const [pid, ws] of this.clients) {
      if (pid === exceptId) continue;
      try { ws.send(text); } catch (e) {}
    }
  }
}

export default {
  async fetch(request, env) {
    // Route every incoming request to a single named Durable Object instance
    const id = env.GAME.idFromName('global');
    const obj = env.GAME.get(id);
    return obj.fetch(request);
  }
};
