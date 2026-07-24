// ===== DURABLE OBJECT =====
export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.storage = ctx.storage;
    this.players = {};
    this.objects = [];
    this.id = ctx.id.toString();
    this.tickInterval = null;
    
    this.tickCount = 0;
    this.lastTickTime = Date.now();
    this.currentTPS = 0;
    this.lastStateSend = Date.now();
    this.lastCleanupTime = Date.now();
    this.isInitialized = false;
    
    // Храним последнее состояние для отправки
    this.lastState = null;
    this.lastStateHash = '';
    
    this.initialize();
  }

  async initialize() {
    if (this.isInitialized) return;
    this.isInitialized = true;
    
    const saved = await this.storage.get('state');
    if (saved) {
      this.objects = saved.objects || [];
      this.players = {};
      
      console.log('Initialized with', this.objects.length, 'objects, players cleared');
      await this.storage.put('state', {
        players: this.players,
        objects: this.objects
      });
    } else {
      for (let i = 0; i < 20; i++) {
        this.objects.push({
          id: i,
          x: (Math.random() - 0.5) * 40,
          z: (Math.random() - 0.5) * 40,
          y: 1,
          w: 2,
          h: 2,
          d: 2,
          color: Math.floor(Math.random() * 0xffffff)
        });
      }
      await this.storage.put('state', {
        players: this.players,
        objects: this.objects
      });
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    
    if (url.pathname === '/reset') {
      this.players = {};
      await this.storage.put('state', {
        players: this.players,
        objects: this.objects
      });
      
      this.ctx.getWebSockets().forEach(ws => {
        try {
          ws.close(1000, 'Server reset');
        } catch(e) {}
      });
      
      if (this.tickInterval) {
        clearInterval(this.tickInterval);
        this.tickInterval = null;
        this.tickCount = 0;
        this.currentTPS = 0;
      }
      
      return new Response(JSON.stringify({
        success: true,
        message: 'All players removed'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (url.pathname === '/ws') {
      await this.cleanupAllPlayers();
      
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      
      this.ctx.acceptWebSocket(server);
      
      const playerId = crypto.randomUUID();
      const startX = (Math.random() - 0.5) * 20;
      const startZ = (Math.random() - 0.5) * 20;
      
      this.players[playerId] = {
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
        wsConnected: true,
        wsId: Math.random().toString(36).substring(7),
        // Добавляем флаги для анимации
        isMoving: false,
        targetX: startX,
        targetZ: startZ,
        moveSpeed: 0
      };
      
      await this.storage.put('state', {
        players: this.players,
        objects: this.objects
      });
      
      server.serializeAttachment({ 
        playerId, 
        lastPingTime: Date.now(),
        connectionTime: Date.now(),
        wsId: this.players[playerId].wsId
      });
      
      server.send(JSON.stringify({
        type: 'init',
        playerId,
        players: this.players,
        objects: this.objects,
        tps: 30,
        serverTime: Date.now()
      }));
      
      if (!this.tickInterval) {
        this.tickInterval = setInterval(() => this.gameTick(), 33);
        this.lastTickTime = Date.now();
        this.tickCount = 0;
      }
      
      return new Response(null, { status: 101, webSocket: client });
    }
    
    if (url.pathname === '/stats') {
      const wsCount = this.ctx.getWebSockets().length;
      const now = Date.now();
      
      return new Response(JSON.stringify({
        tps: this.currentTPS,
        players: Object.keys(this.players).length,
        objects: this.objects.length,
        wsConnections: wsCount,
        playerList: Object.keys(this.players).map(id => {
          const player = this.players[id];
          return {
            id: id.slice(0, 8),
            health: player.health,
            ping: player.ping,
            lastUpdate: Math.floor((now - player.lastUpdate) / 1000) + 's ago',
            wsConnected: player.wsConnected || false,
            wsId: player.wsId,
            isMoving: player.isMoving || false
          };
        })
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (url.pathname === '/cleanup') {
      const removed = await this.cleanupAllPlayers();
      return new Response(JSON.stringify({
        removed: removed,
        remaining: Object.keys(this.players).length
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response('Not found', { status: 404 });
  }

  async cleanupAllPlayers() {
    const now = Date.now();
    const removed = [];
    
    const wsSockets = this.ctx.getWebSockets();
    const activePlayerIds = new Set();
    
    wsSockets.forEach(ws => {
      try {
        const attachment = ws.deserializeAttachment();
        if (attachment?.playerId) {
          activePlayerIds.add(attachment.playerId);
        }
      } catch(e) {}
    });
    
    for (const [id, player] of Object.entries(this.players)) {
      const hasWs = activePlayerIds.has(id);
      const isStale = now - player.lastUpdate > 5000;
      
      if (!hasWs || isStale) {
        removed.push(id);
        delete this.players[id];
      }
    }
    
    if (removed.length > 0) {
      await this.storage.put('state', {
        players: this.players,
        objects: this.objects
      });
      
      console.log(`Cleaned up ${removed.length} players:`, removed);
    }
    
    return removed;
  }

  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message);
      const attachment = ws.deserializeAttachment();
      const playerId = attachment?.playerId;
      
      if (!playerId || !this.players[playerId]) {
        ws.close(1000, 'Player not found');
        return;
      }
      
      const player = this.players[playerId];
      const now = Date.now();
      
      player.lastUpdate = now;
      player.wsConnected = true;
      
      if (data.type === 'ping') {
        const ping = now - (attachment.lastPingTime || now);
        player.ping = Math.min(ping, 1000);
        
        ws.send(JSON.stringify({
          type: 'pong',
          ping: player.ping,
          timestamp: now,
          serverTime: now
        }));
        
        return;
      }
      
      switch(data.type) {
        case 'move':
          const deltaTime = Math.min((now - (player.lastMoveTime || now)) / 1000, 0.05);
          player.lastMoveTime = now;
          
          // Сохраняем старые координаты для определения движения
          const oldX = player.x;
          const oldZ = player.z;
          
          if (data.x !== undefined && data.z !== undefined) {
            player.x = Math.max(-30, Math.min(30, data.x));
            player.z = Math.max(-30, Math.min(30, data.z));
            
            // Определяем, двигается ли игрок
            const dx = player.x - oldX;
            const dz = player.z - oldZ;
            const distance = Math.sqrt(dx*dx + dz*dz);
            
            player.isMoving = distance > 0.01;
            
            if (player.isMoving) {
              // Сохраняем направление движения
              player.targetX = player.x;
              player.targetZ = player.z;
              player.moveSpeed = distance / deltaTime;
            }
          }
          
          if (data.rotation !== undefined) {
            player.rotation = data.rotation;
          }
          
          if (data.pitch !== undefined) {
            player.pitch = Math.max(-Math.PI/2, Math.min(Math.PI/2, data.pitch));
          }
          break;
          
        case 'shoot':
          if (now - (player.lastShootTime || 0) < 100) break;
          player.lastShootTime = now;
          
          const rayX = player.x + Math.sin(player.rotation) * 3;
          const rayZ = player.z + Math.cos(player.rotation) * 3;
          
          let hit = false;
          this.objects = this.objects.map(obj => {
            const dx = obj.x - rayX;
            const dz = obj.z - rayZ;
            if (Math.abs(dx) < 2 && Math.abs(dz) < 2 && obj.h > 0) {
              hit = true;
              return { ...obj, h: Math.max(0, obj.h - 0.5) };
            }
            return obj;
          });
          
          this.objects = this.objects.filter(obj => obj.h > 0);
          break;
          
        case 'chat':
          const name = playerId.slice(0, 6);
          const chatMessage = {
            type: 'chat',
            id: playerId,
            name: name,
            text: data.text.substring(0, 100),
            timestamp: now
          };
          
          const msgStr = JSON.stringify(chatMessage);
          this.ctx.getWebSockets().forEach(wsClient => {
            try {
              wsClient.send(msgStr);
            } catch(e) {}
          });
          break;
      }
      
      // Сохраняем состояние после каждого обновления
      await this.storage.put('state', {
        players: this.players,
        objects: this.objects
      });
      
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  }

  gameTick() {
    this.tickCount++;
    const now = Date.now();
    const elapsed = (now - this.lastTickTime) / 1000;
    
    if (elapsed >= 1) {
      this.currentTPS = Math.round(this.tickCount / elapsed);
      this.tickCount = 0;
      this.lastTickTime = now;
    }
    
    // Очистка каждые 30 тиков
    if (this.tickCount % 30 === 0) {
      this.cleanupAllPlayers();
    }
    
    // ----- ВАЖНО: ПРИНУДИТЕЛЬНОЕ ОБНОВЛЕНИЕ СОСТОЯНИЯ -----
    // Отправляем состояние ВСЕМ игрокам в КАЖДОМ тике
    // Даже если данные не изменились, это нужно для синхронизации
    
    const state = {
      type: 'state',
      players: this.players,
      objects: this.objects,
      tps: this.currentTPS,
      timestamp: now,
      serverTime: now
    };
    
    // Создаем хеш состояния для оптимизации
    const stateHash = JSON.stringify(state);
    
    // Отправляем только если состояние изменилось или прошло больше 100мс
    if (stateHash !== this.lastStateHash || now - this.lastStateSend > 100) {
      this.lastStateHash = stateHash;
      this.lastStateSend = now;
      
      const message = JSON.stringify(state);
      const sockets = this.ctx.getWebSockets();
      
      const activePlayerIds = new Set();
      sockets.forEach((ws) => {
        try {
          const attachment = ws.deserializeAttachment();
          if (attachment?.playerId) {
            activePlayerIds.add(attachment.playerId);
            ws.send(message);
          }
        } catch(e) {
          const attachment = ws.deserializeAttachment();
          if (attachment?.playerId && this.players[attachment.playerId]) {
            this.players[attachment.playerId].wsConnected = false;
          }
        }
      });
      
      // Обновляем флаги подключения
      for (const [id, player] of Object.entries(this.players)) {
        player.wsConnected = activePlayerIds.has(id);
        // Если игрок не двигается, но соединен - помечаем как стоящего
        if (activePlayerIds.has(id) && !player.isMoving) {
          // Просто обновляем время, чтобы не удалили
          player.lastUpdate = now;
        }
      }
    }
    
    if (Object.keys(this.players).length === 0) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
      this.tickCount = 0;
      this.currentTPS = 0;
    }
  }

  webSocketClose(ws) {
    const attachment = ws.deserializeAttachment();
    if (attachment?.playerId && this.players[attachment.playerId]) {
      this.players[attachment.playerId].wsConnected = false;
      this.players[attachment.playerId].lastUpdate = Date.now();
      console.log(`Player ${attachment.playerId} disconnected, marked for cleanup`);
    }
    
    setTimeout(() => {
      this.cleanupAllPlayers();
    }, 1000);
    
    if (Object.keys(this.players).length === 0) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
      this.tickCount = 0;
      this.currentTPS = 0;
    }
  }
  
  webSocketError(ws, error) {
    console.error('WebSocket error:', error);
    this.webSocketClose(ws);
  }
}

// ===== WORKER =====
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    const id = env.GAME_ROOM.idFromName('main');
    const room = env.GAME_ROOM.get(id);
    
    return room.fetch(request);
  }
};
