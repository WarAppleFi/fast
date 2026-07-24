// src/server.js
import { DurableObject } from 'cloudflare:workers';

// ============================================
// GAME ROOM - DURABLE OBJECT
// ============================================
export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.players = new Map();
    this.sessions = new Map();
    this.worldWidth = 800;
    this.worldHeight = 600;
    this.broadcastInterval = null;
  }

  async initialize() {
    // Загружаем сохраненное состояние
    try {
      const stored = await this.ctx.storage.get('state');
      if (stored) {
        this.players = new Map(Object.entries(stored.players || {}));
        this.worldWidth = stored.worldWidth || 800;
        this.worldHeight = stored.worldHeight || 600;
        console.log(`[GameRoom] Loaded ${this.players.size} players`);
      }
    } catch (e) {
      console.error('[GameRoom] Load error:', e);
    }

    // Запускаем постоянную рассылку состояний
    if (!this.broadcastInterval) {
      this.broadcastInterval = setInterval(() => {
        this.broadcastState();
      }, 50); // 20 раз в секунду
    }
  }

  async saveState() {
    try {
      const data = {
        players: Object.fromEntries(this.players),
        worldWidth: this.worldWidth,
        worldHeight: this.worldHeight
      };
      await this.ctx.storage.put('state', data);
    } catch (e) {
      console.error('[GameRoom] Save error:', e);
    }
  }

  broadcastState() {
    if (this.sessions.size === 0) return;

    const state = {
      type: 'state',
      players: {}
    };

    for (const [id, player] of this.players) {
      state.players[id] = {
        x: player.x,
        y: player.y,
        health: player.health,
        angle: player.angle || 0,
        size: player.size || 30
      };
    }

    const msg = JSON.stringify(state);
    const deadSessions = [];

    for (const [ws, playerId] of this.sessions) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(msg);
        } else {
          deadSessions.push(ws);
        }
      } catch (e) {
        deadSessions.push(ws);
      }
    }

    // Удаляем мертвые сессии
    for (const ws of deadSessions) {
      const playerId = this.sessions.get(ws);
      if (playerId) {
        this.players.delete(playerId);
        this.sessions.delete(ws);
        console.log(`[GameRoom] Removed dead session: ${playerId}`);
      }
    }
  }

  async handleWebSocket(ws) {
    await this.initialize();

    const playerId = crypto.randomUUID().slice(0, 8);
    console.log(`[GameRoom] New connection: ${playerId}`);

    // Создаем игрока
    const player = {
      id: playerId,
      x: 100 + Math.random() * (this.worldWidth - 200),
      y: 100 + Math.random() * (this.worldHeight - 200),
      health: 100,
      angle: 0,
      size: 30
    };

    this.players.set(playerId, player);
    this.sessions.set(ws, playerId);

    // Отправляем инициализацию
    const initMsg = {
      type: 'init',
      id: playerId,
      worldWidth: this.worldWidth,
      worldHeight: this.worldHeight,
      players: Array.from(this.players.values()).map(p => ({
        id: p.id,
        x: p.x,
        y: p.y,
        health: p.health,
        angle: p.angle || 0,
        size: p.size || 30
      }))
    };

    try {
      ws.send(JSON.stringify(initMsg));
      console.log(`[GameRoom] Init sent to ${playerId}`);
    } catch (e) {
      console.error('[GameRoom] Init send error:', e);
      this.sessions.delete(ws);
      this.players.delete(playerId);
      return;
    }

    // Сразу отправляем состояние всем
    this.broadcastState();

    // Обработка сообщений
    ws.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleMessage(ws, playerId, data);
      } catch (e) {
        console.error('[GameRoom] Message error:', e);
      }
    });

    ws.addEventListener('close', () => {
      console.log(`[GameRoom] Connection closed: ${playerId}`);
      this.handleDisconnect(ws, playerId);
    });

    ws.addEventListener('error', (error) => {
      console.error(`[GameRoom] Connection error: ${playerId}`, error);
      this.handleDisconnect(ws, playerId);
    });
  }

  handleMessage(ws, playerId, data) {
    const player = this.players.get(playerId);
    if (!player) return;

    if (data.type === 'move') {
      // Ограничиваем движение
      const newX = Math.max(20, Math.min(this.worldWidth - 20, data.x));
      const newY = Math.max(20, Math.min(this.worldHeight - 20, data.y));

      // Обновляем позицию
      player.x = newX;
      player.y = newY;
      player.angle = data.angle || player.angle || 0;

      // Немедленно подтверждаем этому игроку (для отзывчивости)
      const response = {
        type: 'state',
        players: {
          [playerId]: {
            x: player.x,
            y: player.y,
            health: player.health,
            angle: player.angle,
            size: player.size
          }
        }
      };

      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(response));
        }
      } catch (e) {
        // Игнорируем ошибки отправки
      }
    }

    if (data.type === 'ping') {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (e) {
        // Игнорируем
      }
    }
  }

  handleDisconnect(ws, playerId) {
    if (this.sessions.has(ws)) {
      this.sessions.delete(ws);
    }

    if (this.players.has(playerId)) {
      this.players.delete(playerId);
      this.saveState();
      this.broadcastState();
      console.log(`[GameRoom] Player removed: ${playerId}`);
    }
  }
}

// ============================================
// WORKER
// ============================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // WebSocket endpoint
    if (url.pathname === '/') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader !== 'websocket') {
        return new Response('WebSocket required', { status: 400 });
      }

      try {
        // Создаем WebSocket пару
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);

        // Получаем Durable Object
        const id = env.GAME.idFromName('main');
        const gameRoom = env.GAME.get(id);

        // Обрабатываем серверный WebSocket
        await gameRoom.handleWebSocket(server);

        // Возвращаем клиентский WebSocket
        return new Response(null, {
          status: 101,
          webSocket: client,
        });
      } catch (e) {
        console.error('[Worker] Error:', e);
        return new Response('WebSocket error', { status: 500 });
      }
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response('OK', { status: 200 });
    }

    return new Response('Not found', { status: 404 });
  }
};
