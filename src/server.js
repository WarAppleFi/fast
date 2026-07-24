export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Map();
    this.players = new Map();
    this.tickCounter = 0;
    this.tickInterval = 1000 / 60;
    this.heartbeat = null;
    this.worldWidth = 800;
    this.worldHeight = 600;
    this.speed = 5;
  }

  async fetch(request) {
    if (request.headers.get('upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const id = crypto.randomUUID().slice(0, 8);

    server.accept();

    const player = {
      id,
      x: Math.random() * 700 + 50,
      y: Math.random() * 500 + 50,
      health: 100,
      angle: 0,
      size: 30 // размер куба
    };

    this.clients.set(id, { ws: server });
    this.players.set(id, player);

    server.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        const p = this.players.get(id);
        if (!p) return;

        if (msg.type === 'move') {
          p.x = Math.max(20, Math.min(this.worldWidth - 20, msg.x));
          p.y = Math.max(20, Math.min(this.worldHeight - 20, msg.y));
          p.angle = msg.angle || 0;
        }
      } catch (e) {}
    });

    server.addEventListener('close', () => {
      this.clients.delete(id);
      this.players.delete(id);
      if (this.clients.size === 0 && this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
      }
    });

    // Отправляем начальное состояние
    const initPlayers = Array.from(this.players.values()).map(p => ({
      id: p.id,
      x: Math.round(p.x),
      y: Math.round(p.y),
      health: p.health,
      angle: p.angle,
      size: p.size
    }));

    server.send(JSON.stringify({
      type: 'init',
      id,
      players: initPlayers,
      worldWidth: this.worldWidth,
      worldHeight: this.worldHeight
    }));

    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        this.gameLoop();
      }, this.tickInterval);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  gameLoop() {
    const state = {
      type: 'state',
      players: {}
    };

    for (const [id, player] of this.players) {
      state.players[id] = {
        x: Math.round(player.x),
        y: Math.round(player.y),
        health: player.health,
        angle: player.angle,
        size: player.size
      };
    }

    const message = JSON.stringify(state);
    for (const [pid, client] of this.clients) {
      if (client.ws.readyState === 1) {
        try {
          client.ws.send(message);
        } catch (e) {}
      }
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const roomId = url.searchParams.get('room') || 'global';
    const id = env.GAME.idFromName(roomId);
    const obj = env.GAME.get(id);
    return obj.fetch(request);
  }
};
