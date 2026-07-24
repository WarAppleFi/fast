// server.js - Colyseus сервер для Cloudflare Durable Objects
import { Server, Room } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';

// ===== DURABLE OBJECT ROOM =====
export class GameRoom extends Room {
  constructor() {
    super();
    
    // Оптимизированные структуры данных
    this.players = new Map();
    this.objects = [];
    this.pendingUpdates = new Map();
    
    // Настройки производительности
    this.config = {
      tickRate: 60,
      stateSendRate: 20,
      heartbeatRate: 10,
      cleanupInterval: 2000,
      maxPlayers: 50,
      maxObjects: 100,
      moveThreshold: 0.001,
      interpolationDelay: 100
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
    
    // Colyseus специфичные поля
    this.clock = null;
    this.ctx = null;
    this.env = null;
    this.storage = null;
    this.id = 'main';
  }

  // ===== Инициализация =====
  async onCreate(options) {
    console.log('GameRoom created', options);
    
    this.ctx = options.ctx;
    this.env = options.env;
    this.storage = this.ctx.storage;
    this.id = this.ctx.id.toString();
    
    await this.initialize();
    
    // Настройка Colyseus
    this.maxClients = this.config.maxPlayers;
    this.setState({
      players: {},
      objects: [],
      tps: 0,
      timestamp: Date.now()
    });
    
    // Запускаем игровой цикл через Colyseus
    this.clock = this.clock || this.env.clock;
    this.startGameLoop();
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
        console.log(`[GameRoom] Loaded ${this.objects.length} objects, ${this.players.size} players`);
      } else {
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
    this.updateState();
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

  updateState() {
    this.state.players = Object.fromEntries(this.players);
    this.state.objects = this.objects;
    this.state.tps = this.currentTPS;
    this.state.timestamp = Date.now();
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

  // ===== Colyseus методы =====
  async onJoin(client, options) {
    console.log('Player joined:', client.sessionId);
    
    if (this.players.size >= this.config.maxPlayers) {
      client.leave(429, 'Server full');
      return;
    }
    
    await this.cleanupAllPlayers();
    
    // Создаем игрока
    const playerId = client.sessionId;
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
      prevX: startX,
      prevZ: startZ,
      prevRotation: 0,
      prevPitch: 0,
      lastInterpolation: Date.now()
    };
    
    this.players.set(playerId, player);
    this.playerCache.set(playerId, player);
    this.wsCache.set(client, { playerId, lastPingTime: Date.now() });
    
    await this.saveState();
    this.updateState();
    
    // Отправляем инициализацию новому игроку
    client.send('init', {
      playerId,
      config: {
        tickRate: this.config.tickRate,
        interpolationDelay: this.config.interpolationDelay,
        moveThreshold: this.config.moveThreshold
      },
      serverTime: Date.now()
    });
    
    // Отправляем полное состояние всем остальным
    this.broadcastState();
    
    // Убеждаемся, что игровой цикл запущен
    if (!this.tickInterval) {
      this.startGameLoop();
    }
  }

  async onLeave(client, consented) {
    console.log('Player left:', client.sessionId);
    
    try {
      const wsData = this.wsCache.get(client);
      if (wsData && wsData.playerId) {
        const player = this.players.get(wsData.playerId);
        if (player) {
          player.wsConnected = false;
          player.lastUpdate = Date.now();
        }
        this.wsCache.delete(client);
      }
    } catch (error) {
      console.error('[WebSocket] Close error:', error);
    }
    
    // Запускаем очистку через некоторое время
    setTimeout(() => {
      this.cleanupAllPlayers();
    }, 1000);
  }

  onMessage(client, message) {
    try {
      const wsData = this.wsCache.get(client);
      if (!wsData || !wsData.playerId) {
        console.warn('[Colyseus] Invalid connection');
        client.leave(1000, 'Invalid connection');
        return;
      }
      
      const playerId = wsData.playerId;
      const player = this.players.get(playerId);
      
      if (!player) {
        console.warn(`[Colyseus] Player ${playerId} not found`);
        client.leave(1000, 'Player not found');
        return;
      }
      
      const now = Date.now();
      wsData.lastActivity = now;
      player.lastActivity = now;
      
      // Обработка различных типов сообщений
      switch (message.type) {
        case 'ping':
          this.handlePing(client, player, wsData, now);
          break;
          
        case 'move':
          this.handleMove(player, message, now);
          break;
          
        case 'shoot':
          this.handleShoot(player, message, now);
          break;
          
        case 'chat':
          this.handleChat(player, message, now);
          break;
          
        case 'interact':
          this.handleInteract(player, message, now);
          break;
          
        default:
          console.warn(`[Colyseus] Unknown message type: ${message.type}`);
      }
      
    } catch (error) {
      console.error('[Colyseus] Message error:', error);
    }
  }

  // ===== Обработчики сообщений =====
  handlePing(client, player, wsData, now) {
    const ping = now - (wsData.lastPingTime || now);
    player.ping = Math.min(ping, 1000);
    
    client.send('pong', {
      ping: player.ping,
      timestamp: now,
      serverTime: now
    });
    
    wsData.lastPingTime = now;
  }

  handleMove(player, data, now) {
    const deltaTime = Math.min((now - player.lastMoveTime) / 1000, 0.05);
    player.lastMoveTime = now;
    
    player.prevX = player.x;
    player.prevZ = player.z;
    player.prevRotation = player.rotation || 0;
    player.prevPitch = player.pitch || 0;
    player.lastInterpolation = now;
    
    let hasChanges = false;
    const changes = { id: player.id };
    
    if (data.x !== undefined && data.z !== undefined) {
      const newX = Math.max(-30, Math.min(30, data.x));
      const newZ = Math.max(-30, Math.min(30, data.z));
      
      const dx = newX - player.x;
      const dz = newZ - player.z;
      const distance = Math.sqrt(dx*dx + dz*dz);
      
      if (distance < 100) {
        player.x = newX;
        player.z = newZ;
        player.isMoving = distance > 0.01;
        player.speed = distance / deltaTime;
        
        changes.x = player.x;
        changes.z = player.z;
        hasChanges = true;
      }
    }
    
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
    
    if (hasChanges && this.players.size > 1) {
      this.queueUpdate('player', player.id, changes);
      this.updateState();
    }
  }

  handleShoot(player, data, now) {
    const cooldown = 150;
    if (now - (player.lastShootTime || 0) < cooldown) return;
    player.lastShootTime = now;
    
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
    
    this.objects = this.objects.filter(obj => obj.h > 0);
    
    if (objectUpdates.length > 0) {
      this.queueUpdate('objects', null, objectUpdates);
      this.saveState();
      this.updateState();
    }
    
    this.broadcastMessage('shoot_result', {
      playerId: player.id,
      hit: hit,
      position: { x: player.x, z: player.z },
      timestamp: now
    });
  }

  handleChat(player, data, now) {
    const name = player.id.slice(0, 6);
    this.broadcastMessage('chat', {
      id: player.id,
      name: name,
      text: (data.text || '').substring(0, 100),
      timestamp: now
    });
  }

  handleInteract(player, data, now) {
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
    
    if (this.updateBuffer.length > this.maxBufferSize) {
      this.updateBuffer = this.updateBuffer.slice(-this.maxBufferSize);
    }
  }

  processUpdates() {
    if (this.updateBuffer.length === 0) return;
    
    const updates = this.updateBuffer.splice(0, this.updateBuffer.length);
    
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
    
    if (Object.keys(playerUpdates).length > 0) {
      this.sendDeltaUpdate(playerUpdates);
    }
    
    if (objectUpdates.length > 0) {
      this.sendObjectUpdate(objectUpdates);
    }
  }

  sendDeltaUpdate(playerChanges) {
    if (Object.keys(playerChanges).length === 0) return;
    
    this.broadcastMessage('delta', {
      players: playerChanges,
      timestamp: Date.now(),
      serverTime: Date.now()
    });
  }

  sendObjectUpdate(objectChanges) {
    if (objectChanges.length === 0) return;
    
    this.broadcastMessage('delta', {
      objects: objectChanges,
      timestamp: Date.now(),
      serverTime: Date.now()
    });
  }

  broadcastState() {
    const now = Date.now();
    this.updateState();
    this.broadcastMessage('state', {
      players: this.state.players,
      objects: this.state.objects,
      tps: this.currentTPS,
      timestamp: now,
      serverTime: now
    });
    this.lastStateSend = now;
  }

  broadcastMessage(type, data) {
    this.broadcast(type, data);
  }

  // ===== Игровой цикл =====
  gameTick() {
    const now = Date.now();
    this.tickCount++;
    
    const elapsed = (now - this.lastTickTime) / 1000;
    if (elapsed >= 0.5) {
      this.currentTPS = Math.round(this.tickCount / elapsed);
      this.tickCount = 0;
      this.lastTickTime = now;
    }
    
    this.processUpdates();
    
    if (now - this.lastStateSend > 1000 / this.config.stateSendRate) {
      this.broadcastState();
    }
    
    if (this.tickCount % Math.round(this.config.tickRate / this.config.heartbeatRate) === 0) {
      this.sendHeartbeat();
    }
    
    if (now - this.lastCleanup > this.config.cleanupInterval) {
      this.cleanupAllPlayers();
      this.lastCleanup = now;
    }
    
    this.checkConnections();
    
    if (this.players.size === 0) {
      this.stopGameLoop();
    }
  }

  sendHeartbeat() {
    const now = Date.now();
    this.broadcastMessage('heartbeat', {
      timestamp: now,
      serverTime: now,
      players: this.players.size
    });
  }

  checkConnections() {
    const now = Date.now();
    const timeout = 30000;
    
    const activePlayers = new Set();
    
    for (const client of this.clients) {
      try {
        const wsData = this.wsCache.get(client);
        if (wsData && wsData.playerId) {
          activePlayers.add(wsData.playerId);
          
          if (now - wsData.lastActivity > timeout) {
            this.wsCache.delete(client);
            client.leave(1000, 'Connection timeout');
          }
        }
      } catch (error) {
        console.error('[CheckConnections] Error:', error);
      }
    }
    
    for (const [id, player] of this.players) {
      const isActive = activePlayers.has(id);
      player.wsConnected = isActive;
      
      if (isActive) {
        player.lastUpdate = now;
      }
    }
    
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
        this.updateState();
      }
    }
  }

  async cleanupAllPlayers() {
    const now = Date.now();
    const activePlayerIds = new Set();
    
    for (const client of this.clients) {
      try {
        const wsData = this.wsCache.get(client);
        if (wsData && wsData.playerId) {
          activePlayerIds.add(wsData.playerId);
        }
      } catch (error) {
        console.error('[Cleanup] Error getting client data:', error);
      }
    }
    
    const removed = [];
    
    for (const [id, player] of this.players) {
      const isActive = activePlayerIds.has(id);
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
      this.updateState();
      console.log(`[Cleanup] Removed ${removed.length} players`);
      
      if (removed.length > 0 && this.players.size > 0) {
        this.broadcastState();
      }
    }
    
    return removed;
  }

  // ===== Durable Object методы для совместимости =====
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    try {
      if (path === '/reset') {
        return this.handleReset();
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

  async handleReset() {
    this.players.clear();
    await this.saveState();
    
    for (const client of this.clients) {
      try {
        client.leave(1000, 'Server reset');
      } catch (e) {}
    }
    
    this.stopGameLoop();
    this.startGameLoop();
    this.updateState();
    
    return new Response(JSON.stringify({
      success: true,
      message: 'Server reset complete'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  async handleStats() {
    const now = Date.now();
    
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
      wsConnections: this.clients.size,
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
      wsConnections: this.clients.size
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  async handleDebug() {
    return new Response(JSON.stringify({
      players: Array.from(this.players.keys()),
      wsConnections: this.clients.size,
      objects: this.objects.length,
      tickInterval: !!this.tickInterval,
      currentTPS: this.currentTPS,
      bufferSize: this.updateBuffer.length
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // ===== Жизненный цикл Durable Object =====
  async onDispose() {
    console.log('GameRoom disposing');
    this.stopGameLoop();
    await this.saveState();
  }
}

// ===== WORKER =====
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    try {
      // Проверяем, не WebSocket ли это соединение
      if (url.pathname === '/ws' || url.pathname === '/colyseus') {
        // Создаем экземпляр Durable Object
        const id = env.GAME_ROOM.idFromName('main');
        const room = env.GAME_ROOM.get(id);
        
        // Создаем Colyseus сервер внутри Durable Object
        // Для WebSocket используем Durable Object напрямую
        return room.fetch(request);
      }
      
      // Обычные HTTP запросы к API
      if (url.pathname === '/' || url.pathname === '/') {
        return new Response('Game Server Running (Colyseus)', {
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
