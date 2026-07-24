// server.js - Полностью оптимизированный для вашего клиента

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.storage = ctx.storage;
    this.id = ctx.id.toString();
    
    // НАСТРОЙКИ ПОД КЛИЕНТ
    this.config = {
      tickRate: 30,              // 30 TPS
      stateSendRate: 5,          // 5 полных состояний в секунду
      snapshotInterval: 200,     // Снапшоты каждые 200ms
      maxPlayers: 50,
      maxObjects: 100,
      moveThreshold: 0.01,       // Минимальное изменение
      maxSpeed: 12,              // Максимальная скорость
      cleanupInterval: 5000,
      heartbeatRate: 5
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
    
    // Буферы
    this.moveBuffer = [];
    this.stateBuffer = [];
    
    // Кэши
    this.playerCache = new Map();
    this.wsCache = new Map();
    
    this.initialize();
  }

  // ===== ИНИЦИАЛИЗАЦИЯ =====
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
        console.log(`[GameRoom] Loaded ${this.objects.length} objects, ${this.players.size} players`);
      } else {
        this.generateObjects();
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

  // ===== СЖАТИЕ ДАННЫХ (для клиента) =====
  compressPlayer(player) {
    return {
      x: Math.round(player.x * 100) / 100,
      z: Math.round(player.z * 100) / 100,
      y: Math.round(player.y * 100) / 100,
      rotation: Math.round(player.rotation * 100) / 100,
      pitch: Math.round(player.pitch * 100) / 100,
      health: Math.round(player.health)
    };
  }

  compressState() {
    const players = {};
    for (const [id, player] of this.players) {
      players[id] = this.compressPlayer(player);
    }
    
    return {
      players: players,
      objects: this.objects.map(obj => ({
        id: obj.id,
        x: Math.round(obj.x * 100) / 100,
        z: Math.round(obj.z * 100) / 100,
        y: Math.round(obj.y * 100) / 100,
        h: Math.round(obj.h * 10) / 10,
        w: Math.round(obj.w * 10) / 10,
        d: Math.round(obj.d * 10) / 10,
        color: obj.color
      })),
      timestamp: Date.now()
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
    
    // Создаем игрока
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
      isMoving: false,
      speed: 0
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
    
    // ОТПРАВКА INIT (как ждет клиент)
    const initData = {
      type: 'init',
      playerId: playerId,
      players: Object.fromEntries(this.players),
      objects: this.objects,
      config: {
        tickRate: this.config.tickRate,
        interpolationDelay: 80,
        moveThreshold: this.config.moveThreshold
      },
      serverTime: Date.now()
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
      
      // Поддерживаем оба формата (type и t)
      const type = data.type || data.t;
      
      switch (type) {
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
          
        default:
          console.warn(`[WebSocket] Unknown type: ${type}`);
      }
      
    } catch (error) {
      console.error('[WebSocket] Error:', error);
    }
  }

  // ===== PING =====
  handlePing(ws, player, wsData, now) {
    const ping = now - (wsData.lastPingTime || now);
    player.ping = Math.min(ping, 500);
    
    ws.send(JSON.stringify({
      type: 'pong',
      ping: player.ping,
      timestamp: now,
      serverTime: now
    }));
    
    wsData.lastPingTime = now;
  }

  // ===== MOVE (оптимизированный) =====
  handleMove(player, data, now) {
    const deltaTime = Math.min((now - player.lastMoveTime) / 1000, 0.05);
    player.lastMoveTime = now;
    
    let hasChanges = false;
    const changes = { id: player.id };
    
    // Проверяем позицию
    if (data.x !== undefined && data.z !== undefined) {
      const newX = Math.max(-30, Math.min(30, data.x));
      const newZ = Math.max(-30, Math.min(30, data.z));
      
      const dx = newX - player.x;
      const dz = newZ - player.z;
      const distance = Math.sqrt(dx*dx + dz*dz);
      
      // Анти-чит: проверка скорости
      const maxSpeed = this.config.maxSpeed * deltaTime + 0.5;
      
      if (distance < maxSpeed) {
        player.x = newX;
        player.z = newZ;
        player.isMoving = distance > 0.01;
        player.speed = distance / deltaTime;
        
        changes.x = player.x;
        changes.z = player.z;
        hasChanges = true;
      } else if (distance > 1) {
        // Подозрительное движение - телепорт обратно
        console.warn(`[AntiCheat] Player ${player.id} moved too fast: ${distance}`);
        ws.send(JSON.stringify({
          type: 'teleport',
          x: player.x,
          z: player.z
        }));
        return;
      }
    }
    
    // Повороты
    if (data.rotation !== undefined) {
      player.rotation = data.rotation;
      changes.rotation = player.rotation;
      hasChanges = true;
    }
    
    if (data.pitch !== undefined) {
      player.pitch = Math.max(-Math.PI/2, Math.min(Math.PI/2, data.pitch));
      changes.pitch = player.pitch;
      hasChanges = true;
    }
    
    player.lastUpdate = now;
    player.wsConnected = true;
    
    // Добавляем в буфер только если есть изменения
    if (hasChanges) {
      this.moveBuffer.push({
        id: player.id,
        x: player.x,
        z: player.z,
        rotation: player.rotation,
        pitch: player.pitch,
        time: now
      });
      
      // Ограничиваем буфер
      if (this.moveBuffer.length > 100) {
        this.moveBuffer = this.moveBuffer.slice(-50);
      }
    }
  }

  // ===== SHOOT =====
  handleShoot(player, data, now) {
    const cooldown = 100;
    if (now - (player.lastShootTime || 0) < cooldown) return;
    player.lastShootTime = now;
    
    // Проверка попадания
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
        hitObjects.push({
          id: obj.id,
          h: obj.h,
          x: obj.x,
          z: obj.z,
          y: obj.y
        });
      }
    }
    
    this.objects = this.objects.filter(obj => obj.h > 0);
    
    // Отправляем результат
    this.broadcast({
      type: 'shoot_result',
      playerId: player.id,
      hit: hit,
      position: { x: player.x, z: player.z },
      objects: hitObjects,
      timestamp: now
    });
    
    if (hitObjects.length > 0) {
      this.saveState();
    }
  }

  // ===== CHAT =====
  handleChat(player, data, now) {
    const name = player.id.slice(0, 6);
    this.broadcast({
      type: 'chat',
      id: player.id,
      name: name,
      text: (data.text || '').substring(0, 100),
      timestamp: now
    });
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
    
    // 1. Отправка ДЕЛЬТА-ОБНОВЛЕНИЙ (движения)
    if (this.moveBuffer.length > 0) {
      const moves = this.moveBuffer.splice(0, this.moveBuffer.length);
      
      // Группируем по игрокам (берем последнее значение)
      const grouped = {};
      for (const move of moves) {
        if (!grouped[move.id] || move.time > grouped[move.id].time) {
          grouped[move.id] = {
            id: move.id,
            x: move.x,
            z: move.z,
            rotation: move.rotation,
            pitch: move.pitch
          };
        }
      }
      
      // Отправляем как delta (клиент ждет такой формат)
      this.broadcast({
        type: 'delta',
        players: grouped,
        objects: [],
        tps: this.currentTPS,
        timestamp: now,
        serverTime: now
      });
    }
    
    // 2. Отправка СНАПШОТОВ (полное состояние)
    if (now - this.lastSnapshot >= this.config.snapshotInterval) {
      const state = this.compressState();
      this.broadcast({
        type: 'state',
        players: state.players,
        objects: state.objects,
        tps: this.currentTPS,
        timestamp: now,
        serverTime: now
      });
      this.lastSnapshot = now;
    }
    
    // 3. Heartbeat
    if (this.tickCount % Math.round(this.config.tickRate / this.config.heartbeatRate) === 0) {
      this.broadcast({
        type: 'heartbeat',
        timestamp: now,
        serverTime: now,
        players: this.players.size
      });
    }
    
    // 4. Очистка
    if (now - this.lastCleanup > this.config.cleanupInterval) {
      this.cleanupAllPlayers();
      this.lastCleanup = now;
    }
    
    // 5. Проверка соединений
    this.checkConnections();
    
    // 6. Остановка
    if (this.players.size === 0) {
      this.stopGameLoop();
    }
  }

  // ===== ПРОВЕРКА СОЕДИНЕНИЙ =====
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
            ws.close(1000, 'Connection timeout');
          }
        }
      } catch (error) {}
    }
    
    // Обновляем статус
    for (const [id, player] of this.players) {
      const isActive = activePlayers.has(id);
      player.wsConnected = isActive;
      
      if (isActive) {
        player.lastUpdate = now;
      }
    }
    
    // Удаляем неактивных
    if (this.players.size > activePlayers.size) {
      const staleTimeout = 10000;
      const stalePlayers = [];
      
      for (const [id, player] of this.players) {
        if (!player.wsConnected && (now - player.lastUpdate > staleTimeout)) {
          stalePlayers.push(id);
        }
      }
      
      if (stalePlayers.length > 0) {
        for (const id of stalePlayers) {
          this.players.delete(id);
          this.playerCache.delete(id);
        }
        this.saveState();
      }
    }
  }

  // ===== ОЧИСТКА =====
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
      console.log(`[Cleanup] Removed ${removed.length} players`);
    }
    
    return removed;
  }

  // ===== WEBSOCKET СОБЫТИЯ =====
  webSocketClose(ws) {
    try {
      const wsData = this.wsCache.get(ws);
      if (wsData?.playerId) {
        const player = this.players.get(wsData.playerId);
        if (player) {
          player.wsConnected = false;
          player.lastUpdate = Date.now();
          console.log(`[WebSocket] Player ${wsData.playerId} disconnected`);
        }
        this.wsCache.delete(ws);
      }
    } catch (error) {
      console.error('[WebSocket] Close error:', error);
    }
    
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
        for (const ws of this.ctx.getWebSockets()) {
          try { ws.close(1000, 'Reset'); } catch (e) {}
        }
        this.stopGameLoop();
        this.startGameLoop();
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      if (url.pathname === '/stats') {
        return new Response(JSON.stringify({
          tps: this.currentTPS,
          players: this.players.size,
          objects: this.objects.length,
          wsConnections: this.ctx.getWebSockets().length,
          avgPing: Array.from(this.players.values()).reduce((a, p) => a + p.ping, 0) / (this.players.size || 1)
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      if (url.pathname === '/debug') {
        return new Response(JSON.stringify({
          players: Array.from(this.players.keys()),
          wsConnections: this.ctx.getWebSockets().length,
          objects: this.objects.length,
          tickInterval: !!this.tickInterval,
          currentTPS: this.currentTPS,
          moveBuffer: this.moveBuffer.length
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      return new Response('Game Server Running', { status: 200 });
    } catch (error) {
      console.error('[HTTP] Error:', error);
      return new Response('Error', { status: 500 });
    }
  }
}

// ===== WORKER =====
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    try {
      // Корневой путь
      if (url.pathname === '/' || url.pathname === '') {
        return new Response('DO Shooter Server Running', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' }
        });
      }
      
      const id = env.GAME_ROOM.idFromName('main');
      const room = env.GAME_ROOM.get(id);
      return room.fetch(request);
    } catch (error) {
      console.error('[Worker] Error:', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  }
};
