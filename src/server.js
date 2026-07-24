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
    
    // Храним предыдущие состояния для дельта-обновлений
    this.previousState = {
      players: {},
      objects: []
    };
    
    // Очередь изменений
    this.pendingDeltas = [];
    this.lastFullStateTime = 0;
    
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
        wsConnected: true,
        wsId: Math.random().toString(36).substring(7),
        isMoving: false,
        targetX: startX,
        targetZ: startZ,
        moveSpeed: 0
      };
      
      this.players[playerId] = player;
      this.previousState.players[playerId] = { ...player };
      
      await this.storage.put('state', {
        players: this.players,
        objects: this.objects
      });
      
      server.serializeAttachment({ 
        playerId, 
        lastPingTime: Date.now(),
        connectionTime: Date.now(),
        wsId: player.wsId
      });
      
      // Отправляем полное состояние новому игроку
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
        delete this.previousState.players[id];
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

  // Метод для отправки дельта-обновлений
  sendDeltaUpdate(changes) {
    if (Object.keys(changes).length === 0) return;
    
    const message = JSON.stringify({
      type: 'delta',
      players: changes,
      timestamp: Date.now(),
      serverTime: Date.now()
    });
    
    this.ctx.getWebSockets().forEach(ws => {
      try {
        const attachment = ws.deserializeAttachment();
        if (attachment?.playerId) {
          ws.send(message);
        }
      } catch(e) {}
    });
  }

  // Отправка полного состояния (периодическая)
  sendFullState() {
    const now = Date.now();
    const state = {
      type: 'state',
      players: this.players,
      objects: this.objects,
      tps: this.currentTPS,
      timestamp: now,
      serverTime: now,
      isFull: true
    };
    
    const message = JSON.stringify(state);
    this.ctx.getWebSockets().forEach(ws => {
      try {
        const attachment = ws.deserializeAttachment();
        if (attachment?.playerId) {
          ws.send(message);
        }
      } catch(e) {}
    });
    
    this.lastFullStateTime = now;
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
      
      // Переменная для хранения изменений игрока
      let playerChanges = null;
      
      switch(data.type) {
        case 'move':
          const deltaTime = Math.min((now - (player.lastMoveTime || now)) / 1000, 0.05);
          player.lastMoveTime = now;
          
          const oldX = player.x;
          const oldZ = player.z;
          const oldRotation = player.rotation;
          const oldPitch = player.pitch;
          
          let hasChanged = false;
          
          if (data.x !== undefined && data.z !== undefined) {
            player.x = Math.max(-30, Math.min(30, data.x));
            player.z = Math.max(-30, Math.min(30, data.z));
            
            const dx = player.x - oldX;
            const dz = player.z - oldZ;
            const distance = Math.sqrt(dx*dx + dz*dz);
            
            player.isMoving = distance > 0.01;
            
            if (player.isMoving) {
              player.targetX = player.x;
              player.targetZ = player.z;
              player.moveSpeed = distance / deltaTime;
            }
            
            hasChanged = true;
          }
          
          if (data.rotation !== undefined) {
            player.rotation = data.rotation;
            hasChanged = true;
          }
          
          if (data.pitch !== undefined) {
            player.pitch = Math.max(-Math.PI/2, Math.min(Math.PI/2, data.pitch));
            hasChanged = true;
          }
          
          // Если есть изменения - отправляем дельту
          if (hasChanged) {
            playerChanges = {
              [playerId]: {
                x: player.x,
                z: player.z,
                rotation: player.rotation,
                pitch: player.pitch,
                isMoving: player.isMoving
              }
            };
            
            this.sendDeltaUpdate(playerChanges);
          }
          break;
          
        case 'shoot':
          if (now - (player.lastShootTime || 0) < 100) break;
          player.lastShootTime = now;
          
          const rayX = player.x + Math.sin(player.rotation) * 3;
          const rayZ = player.z + Math.cos(player.rotation) * 3;
          
          let hit = false;
          let objectsChanged = false;
          
          this.objects = this.objects.map(obj => {
            const dx = obj.x - rayX;
            const dz = obj.z - rayZ;
            if (Math.abs(dx) < 2 && Math.abs(dz) < 2 && obj.h > 0) {
              hit = true;
              objectsChanged = true;
              return { ...obj, h: Math.max(0, obj.h - 0.5) };
            }
            return obj;
          });
          
          this.objects = this.objects.filter(obj => obj.h > 0);
          
          // Если объекты изменились - отправляем полное состояние (или дельту объектов)
          if (objectsChanged) {
            // Отправляем дельту с объектами
            const objectChanges = {
              objects: this.objects.map(obj => ({
                id: obj.id,
                h: obj.h,
                x: obj.x,
                z: obj.z,
                y: obj.y
              }))
            };
            
            this.ctx.getWebSockets().forEach(wsClient => {
              try {
                const attachment = wsClient.deserializeAttachment();
                if (attachment?.playerId) {
                  wsClient.send(JSON.stringify({
                    type: 'delta',
                    objects: objectChanges.objects,
                    timestamp: now,
                    serverTime: now
                  }));
                }
              } catch(e) {}
            });
          }
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
    
    // Отправляем полное состояние каждую секунду для синхронизации
    if (now - this.lastFullStateTime > 1000) {
      this.sendFullState();
    }
    
    // Отправляем heartbeat для проверки соединения
    if (this.tickCount % 10 === 0) {
      const heartbeat = {
        type: 'heartbeat',
        timestamp: now,
        serverTime: now
      };
      
      const message = JSON.stringify(heartbeat);
      this.ctx.getWebSockets().forEach(ws => {
        try {
          const attachment = ws.deserializeAttachment();
          if (attachment?.playerId) {
            ws.send(message);
          }
        } catch(e) {}
      });
    }
    
    // Обновляем флаги подключения
    const activePlayerIds = new Set();
    this.ctx.getWebSockets().forEach(ws => {
      try {
        const attachment = ws.deserializeAttachment();
        if (attachment?.playerId) {
          activePlayerIds.add(attachment.playerId);
        }
      } catch(e) {}
    });
    
    for (const [id, player] of Object.entries(this.players)) {
      player.wsConnected = activePlayerIds.has(id);
      if (activePlayerIds.has(id)) {
        player.lastUpdate = now;
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
