// server.js - Полностью рабочий сервер для Cloudflare Workers с Durable Object

// ===== DURABLE OBJECT =====
export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.players = new Map();
    this.objects = [];
    this.sessions = new Map();
    this.tickInterval = null;
    this.tickCount = 0;
    this.tps = 0;
    this.lastTpsUpdate = Date.now();
    this.playerNames = new Map();
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    this.initialized = true;
    
    try {
      const stored = await this.state.storage.get('state');
      if (stored) {
        this.players = new Map(Object.entries(stored.players || {}));
        this.objects = stored.objects || [];
      }
    } catch (e) {
      console.error('Storage error:', e);
    }
    
    this.tickInterval = setInterval(() => this.gameTick(), 50);
    
    setInterval(() => {
      const now = Date.now();
      const delta = (now - this.lastTpsUpdate) / 1000;
      if (delta > 0) {
        this.tps = Math.round(this.tickCount / delta);
        this.tickCount = 0;
        this.lastTpsUpdate = now;
      }
    }, 1000);
  }

  gameTick() {
    this.tickCount++;
    
    // Восстановление здоровья
    for (const [id, player] of this.players) {
      if (player.health < 100) {
        player.health = Math.min(100, player.health + 0.5);
      }
    }
    
    this.broadcastDelta();
  }

  async handleWebSocket(ws) {
    try {
      const playerId = crypto.randomUUID();
      const name = `Player${Math.floor(Math.random() * 1000)}`;
      this.playerNames.set(playerId, name);
      
      const spawnPos = this.getRandomSpawn();
      const player = {
        x: spawnPos.x,
        z: spawnPos.z,
        y: 0,
        rotation: 0,
        pitch: 0,
        health: 100,
        name: name
      };
      
      this.players.set(playerId, player);
      this.sessions.set(ws, playerId);
      
      await this.saveState();
      
      // Отправляем инициализацию
      ws.send(JSON.stringify({
        type: 'init',
        playerId: playerId,
        players: this.getPlayersData(),
        objects: this.objects,
        tps: this.tps
      }));
      
      ws.addEventListener('message', async (event) => {
        try {
          const data = JSON.parse(event.data);
          await this.handleMessage(ws, data);
        } catch (e) {
          console.error('Message error:', e);
        }
      });
      
      ws.addEventListener('close', () => {
        this.players.delete(playerId);
        this.sessions.delete(ws);
        this.playerNames.delete(playerId);
        this.saveState();
        this.broadcastDelta();
      });
      
      ws.addEventListener('error', () => {
        this.players.delete(playerId);
        this.sessions.delete(ws);
        this.playerNames.delete(playerId);
      });
    } catch (e) {
      console.error('WebSocket error:', e);
      ws.close();
    }
  }

  async handleMessage(ws, data) {
    const playerId = this.sessions.get(ws);
    if (!playerId) return;
    
    const player = this.players.get(playerId);
    if (!player) return;
    
    switch(data.type) {
      case 'move':
        const dx = data.x - player.x;
        const dz = data.z - player.z;
        const dist = Math.hypot(dx, dz);
        
        if (dist < 0.5) {
          player.x = data.x;
          player.z = data.z;
          player.rotation = data.rotation || player.rotation;
          player.pitch = data.pitch || player.pitch;
        }
        break;
        
      case 'shoot':
        this.handleShoot(playerId, player);
        break;
        
      case 'chat':
        const name = this.playerNames.get(playerId) || 'Unknown';
        this.broadcastChat(name, data.text, playerId);
        break;
        
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
    }
  }

  handleShoot(playerId, player) {
    if (player.health <= 0) return;
    
    const origin = { x: player.x, z: player.z };
    const angle = player.rotation;
    const direction = { x: -Math.sin(angle), z: -Math.cos(angle) };
    
    let closestHit = null;
    let closestDist = Infinity;
    
    for (const [id, target] of this.players) {
      if (id === playerId) continue;
      if (target.health <= 0) continue;
      
      const dx = target.x - origin.x;
      const dz = target.z - origin.z;
      
      const proj = dx * direction.x + dz * direction.z;
      if (proj < 0 || proj > 15) continue;
      
      const perpX = dx - proj * direction.x;
      const perpZ = dz - proj * direction.z;
      const perpDist = Math.hypot(perpX, perpZ);
      
      if (perpDist < 0.8) {
        if (proj < closestDist) {
          closestDist = proj;
          closestHit = id;
        }
      }
    }
    
    if (closestHit) {
      const target = this.players.get(closestHit);
      if (target) {
        target.health = Math.max(0, target.health - 25);
        
        if (target.health <= 0) {
          const spawn = this.getRandomSpawn();
          target.x = spawn.x;
          target.z = spawn.z;
          target.health = 100;
        }
      }
    }
    
    this.broadcastDelta();
  }

  broadcastDelta() {
    const data = {
      type: 'delta',
      players: this.getPlayersDelta(),
      objects: this.objects,
      tps: this.tps
    };
    
    const message = JSON.stringify(data);
    for (const [ws] of this.sessions) {
      try {
        if (ws.readyState === 1) { // WebSocket.OPEN
          ws.send(message);
        }
      } catch (e) {
        // Игнорируем ошибки отправки
      }
    }
  }

  broadcastChat(name, text, senderId) {
    const message = JSON.stringify({
      type: 'chat',
      name: name,
      text: text,
      id: senderId
    });
    
    for (const [ws] of this.sessions) {
      try {
        if (ws.readyState === 1) { // WebSocket.OPEN
          ws.send(message);
        }
      } catch (e) {
        // Игнорируем ошибки отправки
      }
    }
  }

  getPlayersData() {
    const result = {};
    for (const [id, player] of this.players) {
      result[id] = { ...player };
    }
    return result;
  }

  getPlayersDelta() {
    const result = {};
    for (const [id, player] of this.players) {
      result[id] = {
        x: player.x,
        z: player.z,
        rotation: player.rotation,
        pitch: player.pitch,
        health: player.health
      };
    }
    return result;
  }

  getRandomSpawn() {
    const angle = Math.random() * Math.PI * 2;
    const radius = 3 + Math.random() * 5;
    return {
      x: Math.cos(angle) * radius,
      z: Math.sin(angle) * radius
    };
  }

  async saveState() {
    try {
      const data = {
        players: Object.fromEntries(this.players),
        objects: this.objects
      };
      await this.state.storage.put('state', data);
    } catch (e) {
      console.error('Save state error:', e);
    }
  }

  async dispose() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
    }
    await this.saveState();
  }
}

// ===== WORKER =====
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Обработка CORS для всех запросов
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders,
      });
    }
    
    // WebSocket endpoint
    if (url.pathname === '/ws') {
      try {
        // Получаем Durable Object
        const id = env.ROOM.idFromName('main');
        const room = env.ROOM.get(id);
        
        // Инициализируем комнату
        await room.initialize();
        
        // Создаем WebSocket пару
        const [client, server] = Object.values(new WebSocketPair());
        
        // Передаем серверный WebSocket в Durable Object
        room.handleWebSocket(server);
        
        // Возвращаем клиентский WebSocket
        return new Response(null, {
          status: 101,
          webSocket: client,
        });
      } catch (e) {
        console.error('WebSocket upgrade error:', e);
        return new Response('WebSocket upgrade failed: ' + e.message, { 
          status: 400,
          headers: corsHeaders,
        });
      }
    }
    
    // Статус
    if (url.pathname === '/status') {
      return new Response(JSON.stringify({ 
        status: 'ok',
        timestamp: Date.now(),
        environment: env.ENVIRONMENT || 'development'
      }), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
    
    return new Response('Not found', { 
      status: 404,
      headers: corsHeaders
    });
  }
};
