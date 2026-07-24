// ===== DURABLE OBJECT =====
export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.storage = ctx.storage;
    this.id = ctx.id.toString();
    
    // Оптимизированные структуры данных
    this.players = new Map(); // Map для быстрого доступа
    this.objects = [];
    this.pendingUpdates = new Map();
    
    // Настройки производительности
    this.config = {
      tickRate: 60, // 60 тиков в секунду
      stateSendRate: 20, // 20 полных состояний в секунду
      heartbeatRate: 10, // 10 хартбитов в секунду
      cleanupInterval: 2000, // Очистка каждые 2 секунды
      maxPlayers: 50,
      maxObjects: 100,
      moveThreshold: 0.001, // Минимальное изменение для отправки
      interpolationDelay: 100 // Задержка для интерполяции на клиенте
    };
    
    // Состояние
    this.isInitialized = false;
    this.tickInterval = null;
    this.lastTickTime = Date.now();
    this.tickCount = 0;
    this.currentTPS = 0;
    this.lastStateSend = 0;
    this.lastCleanup = 0;
    
    // Оптимизация: буфер обновлений
    this.updateBuffer = [];
    this.bufferSize = 0;
    this.maxBufferSize = 100;
    
    // Кэш для быстрого доступа
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
        // Восстанавливаем игроков из стораджа
        if (saved.players) {
          for (const [id, data] of Object.entries(saved.players)) {
            this.players.set(id, data);
          }
        }
        console.log(`[GameRoom] Loaded ${this.objects.length} objects, ${this.players.size} players`);
      } else {
        // Создаем объекты только если их нет
        if (this.objects.length === 0) {
          this.generateObjects();
        }
        await this.saveState();
      }
    } catch (error) {
      console.error('[GameRoom] Initialization error:', error);
      this.generateObjects();
      await this.saveState();
    }
    
    // Запускаем игровой цикл
    this.startGameLoop();
  }

  generateObjects() {
    this.objects = [];
    const count = Math.min(20, this.config.maxObjects);
    for (let i = 0; i < count; i++) {
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
      const state = {
        players: Object.fromEntries(this.players),
        objects: this.objects
      };
      await this.storage.put('state', state);
    } catch (error) {
      console.error('[GameRoom] Save state error:', error);
    }
  }

  startGameLoop() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
    }
    
    const tickInterval = 1000 / this.config.tickRate;
    this.tickInterval = setInterval(() => this.gameTick(), tickInterval);
    this.lastTickTime = Date.now();
    this.tickCount = 0;
    
    console.log('[GameRoom] Game loop started');
  }

  stopGameLoop() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
      console.log('[GameRoom] Game loop stopped');
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    try {
      // API эндпоинты
      if (path === '/reset') {
        return this.handleReset();
      }
      
      if (path === '/ws') {
        return this.handleWebSocket();
      }
      
      if (path === '/stats') {
        return this.handleStats();
      }
      
      if (path === '/cleanup') {
        return this.handleCleanup();
      }
      
      if (path === '/debug') {
        return this.handleDebug();
      }
      
      return new Response('Not found', { status: 404 });
    } catch (error) {
      console.error('[GameRoom] Request error:', error);
      return new Response('Server error', { status: 500 });
    }
  }

  // ===== Обработчики запросов =====
  async handleReset() {
    this.players.clear();
    await this.saveState();
    
    // Закрываем все WebSocket соединения
    const wsSockets = this.ctx.getWebSockets();
    for (const ws of wsSockets) {
      try {
        ws.close(1000, 'Server reset');
      } catch (e) {}
    }
    
    this.stopGameLoop();
    this.startGameLoop();
    
    return new Response(JSON.stringify({
      success: true,
      message: 'Server reset complete'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

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
      speed: 0,
      // Для интерполяции
      prevX: startX,
      prevZ: startZ,
      prevRotation: 0,
      prevPitch: 0,
      lastInterpolation: Date.now()
    };
    
    this.players.set(playerId, player);
    this.playerCache.set(playerId, player);
    
    // Сохраняем WebSocket с его данными
    const wsData = {
      playerId,
      lastPingTime: Date.now(),
      connectionTime: Date.now(),
      lastActivity: Date.now()
    };
    server.serializeAttachment(wsData);
    this.wsCache.set(server, wsData);
    
    await this.saveState();
    
    // Отправляем инициализацию новому игроку
    const initData = {
      type: 'init',
      playerId,
      players: Object.fromEntries(this.players),
      objects: this.objects,
      config: {
        tickRate: this.config.tickRate,
        interpolationDelay: this.config.interpolationDelay,
        moveThreshold: this.config.moveThreshold
      },
      serverTime: Date.now()
    };
    
    server.send(JSON.stringify(initData));
    
    // Отправляем полное состояние всем остальным
    this.broadcastState();
    
    // Убеждаемся, что игровой цикл запущен
    if (!this.tickInterval) {
      this.startGameLoop();
    }
    
    return new Response(null, { status: 101, webSocket: client });
  }

  async handleStats() {
    const now = Date.now();
    const wsCount = this.ctx.getWebSockets().length;
    
    const players = Array.from(this.players.values()).map(p => ({
      id: p.id.slice(0, 8),
      health: p.health,
      ping: p.ping,
      lastUpdate: Math.floor((now - p.lastUpdate) / 1000) + 's ago',
      isMoving: p.isMoving || false,
      position: `${p.x.toFixed(1)}, ${p.z.toFixed(1)}`,
      wsConnected: p.wsConnected
    }));
    
    return new Response(JSON.stringify({
      tps: this.currentTPS,
      players: this.players.size,
      maxPlayers: this.config.maxPlayers,
      objects: this.objects.length,
      wsConnections: wsCount,
      uptime: Math.floor((now - Date.now()) / 60000) + 'm',
      playerList: players,
      memory: {
        bufferSize: this.updateBuffer.length,
        cacheSize: this.playerCache.size,
        wsCacheSize: this.wsCache.size
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  async handleCleanup() {
    const removed = await this.cleanupAllPlayers();
    return new Response(JSON.stringify({
      removed: removed,
      remaining: this.players.size,
      wsConnections: this.ctx.getWebSockets().length
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  async handleDebug() {
    return new Response(JSON.stringify({
      players: Array.from(this.players.keys()),
      wsConnections: this.ctx.getWebSockets().length,
      objects: this.objects.length,
      tickInterval: !!this.tickInterval,
      currentTPS: this.currentTPS,
      bufferSize: this.updateBuffer.length
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // ===== WebSocket обработчики =====
  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message);
      const wsData = this.wsCache.get(ws);
      
      if (!wsData || !wsData.playerId) {
        console.warn('[WebSocket] Invalid connection');
        ws.close(1000, 'Invalid connection');
        return;
      }
      
      const playerId = wsData.playerId;
      const player = this.players.get(playerId);
      
      if (!player) {
        console.warn(`[WebSocket] Player ${playerId} not found`);
        ws.close(1000, 'Player not found');
        return;
      }
      
      const now = Date.now();
      wsData.lastActivity = now;
      player.lastActivity = now;
      
      // Обработка различных типов сообщений
      switch (data.type) {
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
          
        case 'interact':
          this.handleInteract(player, data, now);
          break;
          
        default:
          console.warn(`[WebSocket] Unknown message type: ${data.type}`);
      }
      
    } catch (error) {
      console.error('[WebSocket] Message error:', error);
    }
  }

  // ===== Обработчики сообщений =====
  handlePing(ws, player, wsData, now) {
    const ping = now - (wsData.lastPingTime || now);
    player.ping = Math.min(ping, 1000);
    
    ws.send(JSON.stringify({
      type: 'pong',
      ping: player.ping,
      timestamp: now,
      serverTime: now
    }));
    
    wsData.lastPingTime = now;
  }

  handleMove(player, data, now) {
    const deltaTime = Math.min((now - player.lastMoveTime) / 1000, 0.05);
    player.lastMoveTime = now;
    
    // Сохраняем предыдущие значения для интерполяции
    player.prevX = player.x;
    player.prevZ = player.z;
    player.prevRotation = player.rotation || 0;
    player.prevPitch = player.pitch || 0;
    player.lastInterpolation = now;
    
    let hasChanges = false;
    const changes = { id: player.id };
    
    // Обновляем позицию с ограничениями
    if (data.x !== undefined && data.z !== undefined) {
      const newX = Math.max(-30, Math.min(30, data.x));
      const newZ = Math.max(-30, Math.min(30, data.z));
      
      const dx = newX - player.x;
      const dz = newZ - player.z;
      const distance = Math.sqrt(dx*dx + dz*dz);
      
      // Проверяем, что движение не слишком большое (защита от телепортов)
      if (distance < 100) { // Максимальное расстояние за один тик
        player.x = newX;
        player.z = newZ;
        player.isMoving = distance > 0.01;
        player.speed = distance / deltaTime;
        
        changes.x = player.x;
        changes.z = player.z;
        hasChanges = true;
      }
    }
    
    // Обновляем повороты
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
    
    // Обновляем состояние игрока
    player.lastUpdate = now;
    player.wsConnected = true;
    
    // Отправляем обновление только если есть изменения
    if (hasChanges && this.players.size > 1) {
      this.queueUpdate('player', player.id, changes);
    }
  }

  handleShoot(player, data, now) {
    const cooldown = 150; // ms
    if (now - (player.lastShootTime || 0) < cooldown) return;
    player.lastShootTime = now;
    
    // Простая проверка попадания
    const rayX = player.x + Math.sin(player.rotation || 0) * 3;
    const rayZ = player.z + Math.cos(player.rotation || 0) * 3;
    
    let hit = false;
    const objectUpdates = [];
    
    this.objects = this.objects.map(obj => {
      const dx = obj.x - rayX;
      const dz = obj.z - rayZ;
      const distance = Math.sqrt(dx*dx + dz*dz);
      
      if (distance < 2 && obj.h > 0) {
        hit = true;
        const newH = Math.max(0, obj.h - 0.5);
        objectUpdates.push({
          id: obj.id,
          h: newH,
          x: obj.x,
          z: obj.z,
          y: obj.y
        });
        return { ...obj, h: newH };
      }
      return obj;
    });
    
    // Удаляем уничтоженные объекты
    this.objects = this.objects.filter(obj => obj.h > 0);
    
    // Отправляем обновления объектов
    if (objectUpdates.length > 0) {
      this.queueUpdate('objects', null, objectUpdates);
      this.saveState();
    }
    
    // Отправляем результат выстрела
    this.broadcastMessage({
      type: 'shoot_result',
      playerId: player.id,
      hit: hit,
      position: { x: player.x, z: player.z },
      timestamp: now
    });
  }

  handleChat(player, data, now) {
    const name = player.id.slice(0, 6);
    const message = {
      type: 'chat',
      id: player.id,
      name: name,
      text: (data.text || '').substring(0, 100),
      timestamp: now
    };
    
    this.broadcastMessage(message);
  }

  handleInteract(player, data, now) {
    // Для будущих интеракций
    console.log(`[GameRoom] Player ${player.id} interacting`);
  }

  // ===== Система обновлений =====
  queueUpdate(type, id, data) {
    const update = {
      type,
      id,
      data,
      timestamp: Date.now()
    };
    
    this.updateBuffer.push(update);
    
    // Ограничиваем размер буфера
    if (this.updateBuffer.length > this.maxBufferSize) {
      this.updateBuffer = this.updateBuffer.slice(-this.maxBufferSize);
    }
  }

  processUpdates() {
    if (this.updateBuffer.length === 0) return;
    
    const updates = this.updateBuffer.splice(0, this.updateBuffer.length);
    
    // Группируем обновления по типу
    const playerUpdates = {};
    const objectUpdates = [];
    
    for (const update of updates) {
      if (update.type === 'player') {
        playerUpdates[update.id] = {
          ...(playerUpdates[update.id] || {}),
          ...update.data
        };
      } else if (update.type === 'objects') {
        objectUpdates.push(...update.data);
      }
    }
    
    // Отправляем группированные обновления
    const now = Date.now();
    
    if (Object.keys(playerUpdates).length > 0) {
      this.sendDeltaUpdate(playerUpdates);
    }
    
    if (objectUpdates.length > 0) {
      this.sendObjectUpdate(objectUpdates);
    }
  }

  sendDeltaUpdate(playerChanges) {
    if (Object.keys(playerChanges).length === 0) return;
    
    const message = JSON.stringify({
      type: 'delta',
      players: playerChanges,
      timestamp: Date.now(),
      serverTime: Date.now()
    });
    
    this.broadcastMessage(message);
  }

  sendObjectUpdate(objectChanges) {
    if (objectChanges.length === 0) return;
    
    const message = JSON.stringify({
      type: 'delta',
      objects: objectChanges,
      timestamp: Date.now(),
      serverTime: Date.now()
    });
    
    this.broadcastMessage(message);
  }

  broadcastState() {
    const now = Date.now();
    const state = {
      type: 'state',
      players: Object.fromEntries(this.players),
      objects: this.objects,
      tps: this.currentTPS,
      timestamp: now,
      serverTime: now
    };
    
    const message = JSON.stringify(state);
    this.broadcastMessage(message);
    this.lastStateSend = now;
  }

  broadcastMessage(message) {
    const wsSockets = this.ctx.getWebSockets();
    const messageStr = typeof message === 'string' ? message : JSON.stringify(message);
    
    for (const ws of wsSockets) {
      try {
        const wsData = this.wsCache.get(ws);
        if (wsData && wsData.playerId) {
          ws.send(messageStr);
        }
      } catch (error) {
        console.error('[Broadcast] Send error:', error);
      }
    }
  }

  // ===== Игровой цикл =====
  gameTick() {
    const now = Date.now();
    this.tickCount++;
    
    // Расчет TPS
    const elapsed = (now - this.lastTickTime) / 1000;
    if (elapsed >= 0.5) {
      this.currentTPS = Math.round(this.tickCount / elapsed);
      this.tickCount = 0;
      this.lastTickTime = now;
    }
    
    // Обработка обновлений
    this.processUpdates();
    
    // Отправка полного состояния
    if (now - this.lastStateSend > 1000 / this.config.stateSendRate) {
      this.broadcastState();
    }
    
    // Хартбит
    if (this.tickCount % Math.round(this.config.tickRate / this.config.heartbeatRate) === 0) {
      this.sendHeartbeat();
    }
    
    // Очистка
    if (now - this.lastCleanup > this.config.cleanupInterval) {
      this.cleanupAllPlayers();
      this.lastCleanup = now;
    }
    
    // Проверка активности соединений
    this.checkConnections();
    
    // Остановка цикла если нет игроков
    if (this.players.size === 0) {
      this.stopGameLoop();
    }
  }

  sendHeartbeat() {
    const now = Date.now();
    const message = JSON.stringify({
      type: 'heartbeat',
      timestamp: now,
      serverTime: now,
      players: this.players.size
    });
    
    this.broadcastMessage(message);
  }

  checkConnections() {
    const now = Date.now();
    const timeout = 30000; // 30 секунд без активности
    
    const wsSockets = this.ctx.getWebSockets();
    const activePlayers = new Set();
    
    // Проверяем WebSocket соединения
    for (const ws of wsSockets) {
      try {
        const wsData = this.wsCache.get(ws);
        if (wsData && wsData.playerId) {
          activePlayers.add(wsData.playerId);
          
          // Проверка активности
          if (now - wsData.lastActivity > timeout) {
            this.wsCache.delete(ws);
            ws.close(1000, 'Connection timeout');
          }
        }
      } catch (error) {
        console.error('[CheckConnections] Error:', error);
      }
    }
    
    // Обновляем статус игроков
    for (const [id, player] of this.players) {
      const isActive = activePlayers.has(id);
      player.wsConnected = isActive;
      
      if (isActive) {
        player.lastUpdate = now;
      }
    }
    
    // Удаляем неактивных через некоторое время
    if (this.players.size > activePlayers.size) {
      const staleTimeout = 10000; // 10 секунд grace period
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

  async cleanupAllPlayers() {
    const now = Date.now();
    const wsSockets = this.ctx.getWebSockets();
    const activePlayerIds = new Set();
    
    // Собираем активные ID
    for (const ws of wsSockets) {
      try {
        const wsData = this.wsCache.get(ws);
        if (wsData && wsData.playerId) {
          activePlayerIds.add(wsData.playerId);
        }
      } catch (error) {
        console.error('[Cleanup] Error getting WS data:', error);
      }
    }
    
    const removed = [];
    
    // Находим игроков для удаления
    for (const [id, player] of this.players) {
      const isActive = activePlayerIds.has(id);
      const isStale = now - player.lastUpdate > 10000;
      const isInactive = now - player.lastActivity > 30000;
      
      if (!isActive || isStale || isInactive) {
        removed.push(id);
      }
    }
    
    // Удаляем игроков
    if (removed.length > 0) {
      for (const id of removed) {
        this.players.delete(id);
        this.playerCache.delete(id);
      }
      
      await this.saveState();
      console.log(`[Cleanup] Removed ${removed.length} players`);
      
      // Отправляем обновление состояния
      if (removed.length > 0 && this.players.size > 0) {
        this.broadcastState();
      }
    }
    
    return removed;
  }

  webSocketClose(ws) {
    try {
      const wsData = this.wsCache.get(ws);
      if (wsData && wsData.playerId) {
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
    
    // Запускаем очистку через некоторое время
    setTimeout(() => {
      this.cleanupAllPlayers();
    }, 1000);
  }

  webSocketError(ws, error) {
    console.error('[WebSocket] Error:', error);
    this.webSocketClose(ws);
  }
}

// ===== WORKER =====
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    try {
      // Маршрутизация запросов
      if (url.pathname === '/' || url.pathname === '/') {
        return new Response('Game Server Running', {
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
