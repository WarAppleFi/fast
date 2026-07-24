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
    
    this.initialize();
  }

  async initialize() {
    const saved = await this.storage.get('state');
    if (saved) {
      this.players = saved.players || {};
      this.objects = saved.objects || [];
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
    
    if (url.pathname === '/ws') {
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
        pitch: 0, // Добавляем pitch для вертикального вращения
        health: 100,
        ping: 0,
        lastMoveTime: Date.now(),
        connectedAt: Date.now(),
        lastUpdate: Date.now()
      };
      
      await this.storage.put('state', {
        players: this.players,
        objects: this.objects
      });
      
      server.serializeAttachment({ 
        playerId, 
        lastPingTime: Date.now(),
        connectionTime: Date.now()
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
      return new Response(JSON.stringify({
        tps: this.currentTPS,
        players: Object.keys(this.players).length,
        objects: this.objects.length,
        playerList: Object.keys(this.players).map(id => ({
          id: id.slice(0, 8),
          health: this.players[id].health,
          ping: this.players[id].ping
        }))
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message);
      const attachment = ws.deserializeAttachment();
      const playerId = attachment?.playerId;
      
      if (!playerId || !this.players[playerId]) {
        // Если игрок не найден, закрываем соединение
        ws.close(1000, 'Player not found');
        return;
      }
      
      const player = this.players[playerId];
      const now = Date.now();
      
      // Обновляем время последнего обновления
      player.lastUpdate = now;
      
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
          
          if (data.x !== undefined && data.z !== undefined) {
            // Ограничиваем границы
            player.x = Math.max(-30, Math.min(30, data.x));
            player.z = Math.max(-30, Math.min(30, data.z));
          }
          
          if (data.rotation !== undefined) {
            player.rotation = data.rotation;
          }
          
          if (data.pitch !== undefined) {
            // Ограничиваем pitch от -π/2 до π/2
            player.pitch = Math.max(-Math.PI/2, Math.min(Math.PI/2, data.pitch));
          }
          break;
          
        case 'shoot':
          // Простая проверка на спам
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
          
          // Удаляем уничтоженные объекты
          this.objects = this.objects.filter(obj => obj.h > 0);
          break;
          
        case 'chat':
          const name = playerId.slice(0, 6);
          const chatMessage = {
            type: 'chat',
            id: playerId,
            name: name,
            text: data.text.substring(0, 100), // Ограничиваем длину
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
      
      // Сохраняем состояние
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
    
    // Проверка на неактивных игроков (таймаут 10 секунд без обновления)
    const timeout = 10000;
    const deadPlayers = [];
    for (const [id, player] of Object.entries(this.players)) {
      if (now - player.lastUpdate > timeout) {
        deadPlayers.push(id);
      }
    }
    
    // Удаляем неактивных игроков
    for (const id of deadPlayers) {
      delete this.players[id];
      console.log(`Player ${id} removed due to timeout`);
    }
    
    if (deadPlayers.length > 0) {
      this.storage.put('state', {
        players: this.players,
        objects: this.objects
      });
    }
    
    // Отправляем состояние всем игрокам
    const state = {
      type: 'state',
      players: this.players,
      objects: this.objects,
      tps: this.currentTPS,
      timestamp: now,
      serverTime: now
    };
    
    const message = JSON.stringify(state);
    const sockets = this.ctx.getWebSockets();
    
    sockets.forEach((ws) => {
      try {
        ws.send(message);
      } catch(e) {
        // Если не удалось отправить, удаляем игрока
        const attachment = ws.deserializeAttachment();
        if (attachment?.playerId) {
          delete this.players[attachment.playerId];
        }
      }
    });
    
    // Если игроков нет, останавливаем tick
    if (Object.keys(this.players).length === 0) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
      this.tickCount = 0;
      this.currentTPS = 0;
    }
  }

  webSocketClose(ws) {
    const attachment = ws.deserializeAttachment();
    if (attachment?.playerId) {
      delete this.players[attachment.playerId];
      console.log(`Player ${attachment.playerId} disconnected`);
      
      this.storage.put('state', {
        players: this.players,
        objects: this.objects
      });
    }
    
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
