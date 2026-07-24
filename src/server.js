// src/server.js
import { DurableObject } from 'cloudflare:workers';

// ============ DURABLE OBJECT ============
export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.players = new Map();
    this.sessions = new Map(); // WebSocket -> playerId
    this.worldWidth = 800;
    this.worldHeight = 600;
    this.tickInterval = null;
    this.lastBroadcast = 0;
    this.updateCounter = 0;
    
    // Автоматический тик для стабильности
    this.ctx.blockConcurrencyWhile(async () => {
      await this.loadState();
      this.startTicking();
    });
  }

  async loadState() {
    try {
      const stored = await this.ctx.storage.get('state');
      if (stored) {
        this.players = new Map(Object.entries(stored.players || {}));
        this.worldWidth = stored.worldWidth || 800;
        this.worldHeight = stored.worldHeight || 600;
        console.log(`[GameRoom] Loaded ${this.players.size} players from storage`);
      }
    } catch (e) {
      console.error('[GameRoom] Load state error:', e);
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
      console.error('[GameRoom] Save state error:', e);
    }
  }

  startTicking() {
    if (this.tickInterval) return;
    this.tickInterval = setInterval(() => {
      this.tick();
    }, 50); // 20 FPS для плавности
  }

  tick() {
    // Отправляем состояние всем игрокам 20 раз в секунду
    this.broadcastState();
    
    // Сохраняем состояние каждые 2 секунды
    this.updateCounter++;
    if (this.updateCounter % 40 === 0) {
      this.saveState();
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
        size: player.size || 30,
        id: id
      };
    }
    
    const msg = JSON.stringify(state);
    
    // Отправляем всем
    for (const [ws, playerId] of this.sessions) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(msg);
        }
      } catch (e) {
        console.error('[GameRoom] Broadcast error:', e);
      }
    }
  }

  async handleWebSocket(ws) {
    const playerId = crypto.randomUUID().slice(0, 8);
    console.log(`[GameRoom] New player: ${playerId}`);
    
    // Создаем игрока
    const player = {
      id: playerId,
      x: 50 + Math.random() * (this.worldWidth - 100),
      y: 50 + Math.random() * (this.worldHeight - 100),
      health: 100,
      angle: 0,
      size: 30,
      speed: 5
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
    } catch (e) {
      console.error('[GameRoom] Init send error:', e);
    }
    
    // Сразу отправляем состояние всем
    this.broadcastState();
    
    // Обработка сообщений
    ws.addEventListener('message', async (event) => {
      try {
        const data = JSON.parse(event.data);
        await this.handleMessage(ws, playerId, data);
      } catch (e) {
        console.error('[GameRoom] Message error:', e);
      }
    });
    
    ws.addEventListener('close', () => {
      this.handleDisconnect(ws, playerId);
    });
    
    ws.addEventListener('error', (e) => {
      console.error('[GameRoom] WebSocket error:', e);
      this.handleDisconnect(ws, playerId);
    });
  }

  async handleMessage(ws, playerId, data) {
    const player = this.players.get(playerId);
    if (!player) return;
    
    // Обработка движения
    if (data.type === 'move') {
      // Ограничиваем движение
      const newX = Math.max(20, Math.min(this.worldWidth - 20, data.x));
      const newY = Math.max(20, Math.min(this.worldHeight - 20, data.y));
      
      // Плавное обновление
      player.x = newX;
      player.y = newY;
      player.angle = data.angle || player.angle || 0;
      
      // Немедленно отправляем обновление этому игроку (для отзывчивости)
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
        ws.send(JSON.stringify(response));
      } catch (e) {
        // Игнорируем ошибки отправки
      }
    }
    
    // Обработка пинга
    if (data.type === 'ping') {
      try {
        ws.send(JSON.stringify({ type: 'pong' }));
      } catch (e) {
        // Игнорируем
      }
    }
  }

  handleDisconnect(ws, playerId) {
    console.log(`[GameRoom] Player disconnected: ${playerId}`);
    
    this.sessions.delete(ws);
    this.players.delete(playerId);
    
    // Сохраняем состояние
    this.saveState();
    
    // Оповещаем остальных
    this.broadcastState();
  }
}

// ============ WORKER ============
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // WebSocket upgrade
    if (url.pathname === '/') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader !== 'websocket') {
        return new Response('WebSocket required', { status: 400 });
      }
      
      try {
        // Получаем или создаем игровую комнату
        const id = env.GAME.idFromName('main');
        const gameRoom = env.GAME.get(id);
        
        // Создаем WebSocket пару
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        
        // Передаем серверный WebSocket в Durable Object
        await gameRoom.handleWebSocket(server);
        
        // Возвращаем клиентский WebSocket
        return new Response(null, {
          status: 101,
          webSocket: client,
        });
      } catch (e) {
        console.error('[Worker] WebSocket error:', e);
        return new Response('WebSocket error', { status: 500 });
      }
    }
    
    // Статус
    if (url.pathname === '/status') {
      return new Response(JSON.stringify({
        status: 'ok',
        timestamp: Date.now()
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response('Not found', { status: 404 });
  }
};
