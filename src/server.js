// ===== DURABLE OBJECT - ИСПРАВЛЕННАЯ ВЕРСИЯ =====
export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.storage = ctx.storage;
    this.id = ctx.id.toString();
    
    // ОПТИМИЗИРОВАННЫЕ настройки
    this.config = {
      tickRate: 30,              // ↓ 30 вместо 60
      stateSendRate: 5,          // ↓ 5 полных состояний в секунду
      heartbeatRate: 5,
      cleanupInterval: 5000,
      maxPlayers: 50,
      maxObjects: 100,
      moveThreshold: 0.05,       // ↑ 0.05 вместо 0.001
      interpolationDelay: 50,    // ↓ 50ms
      maxSpeed: 10,              // Максимальная скорость
      snapshotInterval: 200      // Снапшоты каждые 200ms
    };
    
    // Состояние
    this.players = new Map();
    this.objects = [];
    this.isInitialized = false;
    this.tickInterval = null;
    this.lastTickTime = Date.now();
    this.tickCount = 0;
    this.currentTPS = 0;
    this.lastSnapshot = 0;
    this.lastCleanup = 0;
    
    // РАЗДЕЛЬНЫЕ буферы
    this.moveBuffer = [];      // Высокий приоритет
    this.stateBuffer = [];     // Низкий приоритет
    
    // Кэши
    this.playerCache = new Map();
    this.wsCache = new Map();
    
    this.initialize();
  }

  async initialize() {
    if (this.isInitialized) return;
    this.isInitialized = true;
    
    try {
      const saved = await this.storage.get('state');
      if (saved && saved.objects) {
        this.objects = saved.objects;
        if (saved.players) {
          for (const [id, data] of Object.entries(saved.players)) {
            this.players.set(id, data);
          }
        }
      } else {
        if (this.objects.length === 0) {
          this.generateObjects();
        }
        await this.saveState();
      }
    } catch (error) {
      console.error('[GameRoom] Init error:', error);
      this.generateObjects();
      await this.saveState();
    }
    
    this.startGameLoop();
  }

  generateObjects() {
    this.objects = [];
    for (let i = 0; i < 20; i++) {
      this.objects.push({
        id: i,
        x: (Math.random() - 0.5) * 40,
        z: (Math.random() - 0.5) * 40,
        y: 1,
        w: 2,
        h: 2 + Math.random() * 3,
        d: 2,
        color: Math.floor(Math.random() * 0xffffff)
      });
    }
  }

  async saveState() {
    try {
      await this.storage.put('state', {
        players: Object.fromEntries(this.players),
        objects: this.objects
      });
    } catch (error) {
      console.error('[GameRoom] Save error:', error);
    }
  }

  startGameLoop() {
    if (this.tickInterval) clearInterval(this.tickInterval);
    this.tickInterval = setInterval(() => this.gameTick(), 1000 / this.config.tickRate);
    this.lastTickTime = Date.now();
    this.tickCount = 0;
    console.log('[GameRoom] Game loop started');
  }

  stopGameLoop() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  // ===== СЖАТИЕ ДАННЫХ =====
  compressPlayer(player) {
    return {
      i: player.id,
      x: Math.round(player.x * 100) / 100,
      z: Math.round(player.z * 100) / 100,
      r: Math.round(player.rotation * 100) / 100,
      p: Math.round(player.pitch * 100) / 100,
      h: Math.round(player.health)
    };
  }

  compressState() {
    const players = {};
    for (const [id, player] of this.players) {
      players[id] = this.compressPlayer(player);
    }
    
    return {
      p: players,
      o: this.objects.map(obj => ({
        i: obj.id,
        x: Math.round(obj.x * 100) / 100,
        z: Math.round(obj.z * 100) / 100,
        y: Math.round(obj.y * 100) / 100,
        h: Math.round(obj.h * 10) / 10
      })),
      t: Date.now()
    };
  }

  // ===== WEB SOCKET =====
  async handleWebSocket() {
    if (this.players.size >= this.config.maxPlayers) {
      return new Response('Server full', { status: 429 });
    }
    
    await this.cleanupAllPlayers();
    
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    
    const playerId = crypto.randomUUID();
    const startX = (Math.random() - 0.5) * 10;
    const startZ = (Math.random() - 0.5) * 10;
    
    const player = {
      id: playerId,
      x: startX,
      z: startZ,
      y: 0.5,
      rotation: 0,
      pitch: 0,
      health: 100,
      ping: 0,
      lastMoveTime: Date.now(),
      connectedAt: Date.now(),
      lastUpdate: Date.now(),
      lastActivity: Date.now(),
      wsConnected: true,
      // Для интерполяции на клиенте
      prevX: startX,
      prevZ: startZ,
      prevRotation: 0,
      prevPitch: 0,
      lastInterpolation: Date.now(),
      // Валидация движения
      serverX: startX,
      serverZ: startZ
    };
    
    this.players.set(playerId, player);
    this.playerCache.set(playerId, player);
    
    const wsData = {
      playerId,
      lastPingTime: Date.now(),
      lastActivity: Date.now()
    };
    server.serializeAttachment(wsData);
    this.wsCache.set(server, wsData);
    
    await this.saveState();
    
    // ИНИЦИАЛИЗАЦИЯ (сжатая)
    const initData = {
      t: 'init',
      id: playerId,
      state: this.compressState(),
      cfg: {
        tickRate: this.config.tickRate,
        interpolationDelay: this.config.interpolationDelay,
        moveThreshold: this.config.moveThreshold
      },
      time: Date.now()
    };
    
    server.send(JSON.stringify(initData));
    
    if (!this.tickInterval) {
      this.startGameLoop();
    }
    
    return new Response(null, { status: 101, webSocket: client });
  }

  // ===== ОБРАБОТЧИКИ СООБЩЕНИЙ =====
  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message);
      const wsData = this.wsCache.get(ws);
      
      if (!wsData?.playerId) {
        ws.close(1000);
        return;
      }
      
      const player = this.players.get(wsData.playerId);
      if (!player) {
        ws.close(1000);
        return;
      }
      
      const now = Date.now();
      wsData.lastActivity = now;
      player.lastActivity = now;
      
      switch (data.t || data.type) {
        case 'ping':
          this.handlePing(ws, player, wsData, now);
          break;
          
        case 'move':
          this.handleMove(player, data, now);
          break;
          
        case 'shoot':
          this.handleShoot(player, data, now);
          break;
          
        case 'chat':
          this.handleChat(player, data, now);
          break;
      }
      
    } catch (error) {
      console.error('[WebSocket] Error:', error);
    }
  }

  // ===== ОПТИМИЗИРОВАННЫЙ MOVE =====
  handleMove(player, data, now) {
    const deltaTime = Math.min((now - player.lastMoveTime) / 1000, 0.05);
    player.lastMoveTime = now;
    
    // Проверяем, есть ли изменения
    const dx = (data.x || 0) - player.x;
    const dz = (data.z || 0) - player.z;
    const distance = Math.sqrt(dx*dx + dz*dz);
    
    // Игнорируем слишком маленькие движения (0.05 вместо 0.001)
    if (distance < this.config.moveThreshold) {
      return;
    }
    
    // АВТОРИЗАЦИЯ движения (защита от читов)
    const maxSpeed = this.config.maxSpeed * deltaTime;
    if (distance > maxSpeed + 1) {
      // Подозрительное движение - телепорт
      console.warn(`[AntiCheat] Player ${player.id} moved too fast: ${distance}`);
      // Отправляем корректную позицию
      ws.send(JSON.stringify({
        t: 'teleport',
        x: player.x,
        z: player.z
      }));
      return;
    }
    
    // Сохраняем предыдущую позицию для интерполяции
    player.prevX = player.x;
    player.prevZ = player.z;
    player.prevRotation = player.rotation || 0;
    player.prevPitch = player.pitch || 0;
    player.lastInterpolation = now;
    
    // Применяем движение
    if (data.x !== undefined && data.z !== undefined) {
      const newX = Math.max(-30, Math.min(30, data.x));
      const newZ = Math.max(-30, Math.min(30, data.z));
      
      player.x = newX;
      player.z = newZ;
      player.isMoving = distance > 0.01;
      player.speed = distance / deltaTime;
    }
    
    if (data.rotation !== undefined) {
      player.rotation = data.rotation;
    }
    
    if (data.pitch !== undefined) {
      player.pitch = Math.max(-Math.PI/2, Math.min(Math.PI/2, data.pitch));
    }
    
    player.lastUpdate = now;
    player.wsConnected = true;
    
    // Добавляем в БУФЕР ДВИЖЕНИЙ (высокий приоритет)
    this.moveBuffer.push({
      id: player.id,
      x: player.x,
      z: player.z,
      r: player.rotation,
      p: player.pitch,
      time: now
    });
    
    // Ограничиваем размер буфера
    if (this.moveBuffer.length > 50) {
      this.moveBuffer = this.moveBuffer.slice(-30);
    }
  }

  // ===== СТРЕЛЬБА =====
  handleShoot(player, data, now) {
    const cooldown = 100;
    if (now - (player.lastShootTime || 0) < cooldown) return;
    player.lastShootTime = now;
    
    // Простая проверка попадания
    const rayX = player.x + Math.sin(player.rotation || 0) * 3;
    const rayZ = player.z + Math.cos(player.rotation || 0) * 3;
    
    let hit = false;
    const hitObjects = [];
    
    for (const obj of this.objects) {
      const dx = obj.x - rayX;
      const dz = obj.z - rayZ;
      const distance = Math.sqrt(dx*dx + dz*dz);
      
      if (distance < 2 && obj.h > 0) {
        hit = true;
        obj.h = Math.max(0, obj.h - 0.5);
        hitObjects.push({ id: obj.id, h: obj.h });
      }
    }
    
    this.objects = this.objects.filter(obj => obj.h > 0);
    
    // Отправляем результат
    this.broadcast({
      t: 'shoot',
      id: player.id,
      hit: hit,
      objects: hitObjects,
      time: now
    });
    
    if (hitObjects.length > 0) {
      this.saveState();
    }
  }

  handleChat(player, data, now) {
    const name = player.id.slice(0, 6);
    this.broadcast({
      t: 'chat',
      id: player.id,
      name: name,
      text: (data.text || '').substring(0, 100),
      time: now
    });
  }

  handlePing(ws, player, wsData, now) {
    const ping = now - (wsData.lastPingTime || now);
    player.ping = Math.min(ping, 500);
    
    ws.send(JSON.stringify({
      t: 'pong',
      ping: player.ping,
      time: now
    }));
    
    wsData.lastPingTime = now;
  }

  // ===== BROADCAST =====
  broadcast(data) {
    const message = JSON.stringify(data);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch (e) {}
    }
  }

  // ===== ИГРОВОЙ ЦИКЛ =====
  gameTick() {
    const now = Date.now();
    this.tickCount++;
    
    // Расчет TPS
    if (now - this.lastTickTime >= 1000) {
      this.currentTPS = this.tickCount;
      this.tickCount = 0;
      this.lastTickTime = now;
    }
    
    // 1. Отправляем ДВИЖЕНИЯ (каждый тик, высокий приоритет)
    if (this.moveBuffer.length > 0) {
      const moves = this.moveBuffer.splice(0, this.moveBuffer.length);
      
      // Группируем по игрокам (берем последнее значение)
      const grouped = {};
      for (const move of moves) {
        grouped[move.id] = {
          id: move.id,
          x: move.x,
          z: move.z,
          r: move.r,
          p: move.p
        };
      }
      
      this.broadcast({
        t: 'delta',
        players: Object.values(grouped),
        time: now
      });
    }
    
    // 2. Отправляем СНАПШОТЫ (каждые 200ms, полное состояние)
    if (now - this.lastSnapshot >= this.config.snapshotInterval) {
      this.broadcast({
        t: 'snap',
        state: this.compressState(),
        time: now
      });
      this.lastSnapshot = now;
    }
    
    // 3. Очистка
    if (now - this.lastCleanup > this.config.cleanupInterval) {
      this.cleanupAllPlayers();
      this.lastCleanup = now;
    }
    
    // 4. Проверка соединений
    this.checkConnections();
    
    // 5. Остановка
    if (this.players.size === 0) {
      this.stopGameLoop();
    }
  }

  // ===== ОСТАЛЬНЫЕ МЕТОДЫ =====
  checkConnections() {
    const now = Date.now();
    const timeout = 30000;
    const wsSockets = this.ctx.getWebSockets();
    const activePlayers = new Set();
    
    for (const ws of wsSockets) {
      try {
        const wsData = this.wsCache.get(ws);
        if (wsData?.playerId) {
          activePlayers.add(wsData.playerId);
          if (now - wsData.lastActivity > timeout) {
            this.wsCache.delete(ws);
            ws.close(1000, 'Timeout');
          }
        }
      } catch (error) {}
    }
    
    for (const [id, player] of this.players) {
      player.wsConnected = activePlayers.has(id);
      if (player.wsConnected) {
        player.lastUpdate = now;
      }
    }
  }

  async cleanupAllPlayers() {
    const now = Date.now();
    const wsSockets = this.ctx.getWebSockets();
    const activePlayers = new Set();
    
    for (const ws of wsSockets) {
      try {
        const wsData = this.wsCache.get(ws);
        if (wsData?.playerId) {
          activePlayers.add(wsData.playerId);
        }
      } catch (error) {}
    }
    
    const removed = [];
    for (const [id, player] of this.players) {
      const isActive = activePlayers.has(id);
      const isStale = now - player.lastUpdate > 10000;
      const isInactive = now - player.lastActivity > 30000;
      
      if (!isActive || isStale || isInactive) {
        removed.push(id);
      }
    }
    
    if (removed.length > 0) {
      for (const id of removed) {
        this.players.delete(id);
        this.playerCache.delete(id);
      }
      await this.saveState();
    }
    
    return removed;
  }

  webSocketClose(ws) {
    try {
      const wsData = this.wsCache.get(ws);
      if (wsData?.playerId) {
        const player = this.players.get(wsData.playerId);
        if (player) {
          player.wsConnected = false;
          player.lastUpdate = Date.now();
        }
        this.wsCache.delete(ws);
      }
    } catch (error) {}
    
    setTimeout(() => this.cleanupAllPlayers(), 1000);
  }

  webSocketError(ws, error) {
    console.error('[WebSocket] Error:', error);
    this.webSocketClose(ws);
  }

  // ===== HTTP =====
  async fetch(request) {
    const url = new URL(request.url);
    
    try {
      if (url.pathname === '/ws') {
        return this.handleWebSocket();
      }
      
      if (url.pathname === '/reset') {
        this.players.clear();
        await this.saveState();
        const wsSockets = this.ctx.getWebSockets();
        for (const ws of wsSockets) {
          try { ws.close(1000, 'Reset'); } catch (e) {}
        }
        this.stopGameLoop();
        this.startGameLoop();
        return new Response(JSON.stringify({ success: true }));
      }
      
      if (url.pathname === '/stats') {
        return new Response(JSON.stringify({
          tps: this.currentTPS,
          players: this.players.size,
          objects: this.objects.length,
          wsConnections: this.ctx.getWebSockets().length,
          avgPing: Array.from(this.players.values()).reduce((a, p) => a + p.ping, 0) / (this.players.size || 1)
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      
      return new Response('Not found', { status: 404 });
    } catch (error) {
      console.error('[HTTP] Error:', error);
      return new Response('Error', { status: 500 });
    }
  }
}

// ===== WORKER =====
export default {
  async fetch(request, env) {
    try {
      const id = env.GAME_ROOM.idFromName('main');
      const room = env.GAME_ROOM.get(id);
      return room.fetch(request);
    } catch (error) {
      console.error('[Worker] Error:', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  }
};
