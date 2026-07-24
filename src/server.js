// server.js - Cloudflare Worker с Durable Object

// ===== DURABLE OBJECT =====
export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.players = new Map(); // id -> {x, z, rotation, pitch, health, name}
    this.objects = [];
    this.sessions = new Map(); // WebSocket -> playerId
    this.tickInterval = null;
    this.lastTick = Date.now();
    this.tickCount = 0;
    this.tps = 0;
    this.lastTpsUpdate = Date.now();
  }

  async initialize() {
    // Восстанавливаем состояние из storage
    const stored = await this.state.storage.get('state');
    if (stored) {
      this.players = new Map(Object.entries(stored.players || {}));
      this.objects = stored.objects || [];
    }
    
    // Запускаем игровой тик (20 раз в секунду)
    this.tickInterval = setInterval(() => this.gameTick(), 50);
    
    // Обновляем TPS каждую секунду
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

  // ===== ИГРОВОЙ ТИК =====
  gameTick() {
    this.tickCount++;
    
    // Обновляем здоровье (регенерация)
    for (const [id, player] of this.players) {
      if (player.health < 100) {
        player.health = Math.min(100, player.health + 0.5);
      }
    }
    
    // Отправляем дельту всем игрокам
    this.broadcastDelta();
  }

  // ===== ОБРАБОТКА ВЕБСОКЕТА =====
  async handleWebSocket(ws) {
    const playerId = crypto.randomUUID();
    
    // Создаем игрока
    const spawnPos = this.getRandomSpawn();
    const player = {
      x: spawnPos.x,
      z: spawnPos.z,
      y: 0,
      rotation: 0,
      pitch: 0,
      health: 100,
      name: `Player${Math.floor(Math.random() * 1000)}`
    };
    
    this.players.set(playerId, player);
    this.sessions.set(ws, playerId);
    
    // Сохраняем состояние
    await this.saveState();
    
    // Отправляем инициализацию
    ws.send(JSON.stringify({
      type: 'init',
      playerId: playerId,
      players: this.getPlayersData(),
      objects: this.objects,
      tps: this.tps
    }));
    
    // Обработка сообщений
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
      this.saveState();
      this.broadcastDelta();
    });
  }

  // ===== ОБРАБОТКА СООБЩЕНИЙ =====
  async handleMessage(ws, data) {
    const playerId = this.sessions.get(ws);
    if (!playerId) return;
    
    const player = this.players.get(playerId);
    if (!player) return;
    
    switch(data.type) {
      case 'move':
        // Проверяем валидность движения (античит)
        const dx = data.x - player.x;
        const dz = data.z - player.z;
        const dist = Math.hypot(dx, dz);
        
        // Максимальная скорость ~6 единиц в секунду, тик 50мс => макс 0.3 за тик
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
        const name = player.name || 'Unknown';
        this.broadcastChat(name, data.text, playerId);
        break;
        
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
    }
  }

  // ===== СТРЕЛЬБА =====
  handleShoot(playerId, player) {
    // Проверяем, жив ли игрок
    if (player.health <= 0) return;
    
    // Рейкаст по всем игрокам
    const origin = { x: player.x, z: player.z };
    const angle = player.rotation;
    const direction = { x: -Math.sin(angle), z: -Math.cos(angle) };
    
    let closestHit = null;
    let closestDist = Infinity;
    
    for (const [id, target] of this.players) {
      if (id === playerId) continue;
      if (target.health <= 0) continue;
      
      // Проверка попадания в прямоугольник 0.7x0.5
      const dx = target.x - origin.x;
      const dz = target.z - origin.z;
      
      // Проекция на направление
      const proj = dx * direction.x + dz * direction.z;
      if (proj < 0 || proj > 15) continue; // Макс дистанция 15
      
      // Перпендикулярное расстояние
      const perpX = dx - proj * direction.x;
      const perpZ = dz - proj * direction.z;
      const perpDist = Math.hypot(perpX, perpZ);
      
      if (perpDist < 0.8) { // Ширина игрока ~0.7
        if (proj < closestDist) {
          closestDist = proj;
          closestHit = id;
        }
      }
    }
    
    // Наносим урон
    if (closestHit) {
      const target = this.players.get(closestHit);
      if (target) {
        target.health = Math.max(0, target.health - 25);
        
        // Если игрок умер, телепортируем
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

  // ===== РАССЫЛКА =====
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
        if (ws.readyState === WebSocket.OPEN) {
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
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(message);
        }
      } catch (e) {}
    }
  }

  // ===== ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ =====
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
    const data = {
      players: Object.fromEntries(this.players),
      objects: this.objects
    };
    await this.state.storage.put('state', data);
  }

  // Очистка при остановке
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
    
    // WebSocket endpoint
    if (url.pathname === '/ws') {
      const upgrade = await env.ROOM.getWebSocket(request);
      if (upgrade) {
        const room = env.ROOM.get(env.ROOM.idFromName('main'));
        await room.initialize();
        room.handleWebSocket(upgrade);
        return new Response(null, { status: 101, webSocket: upgrade });
      }
      return new Response('WebSocket upgrade failed', { status: 400 });
    }
    
    // Статус
    if (url.pathname === '/status') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response('Not found', { status: 404 });
  }
};
