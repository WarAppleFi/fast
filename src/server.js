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
      this.objects = saved.objects || {};
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
      this.players[playerId] = {
        id: playerId,
        x: (Math.random() - 0.5) * 20,
        z: (Math.random() - 0.5) * 20,
        y: 0.5,
        rotation: 0,
        health: 100,
        ping: 0,
        lastMoveTime: Date.now(),
        speedX: 0,
        speedZ: 0,
        // Добавляем очередь команд для лучшей синхронизации
        inputQueue: []
      };
      
      await this.storage.put('state', {
        players: this.players,
        objects: this.objects
      });
      
      server.serializeAttachment({ playerId, lastPingTime: Date.now() });
      
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
        objects: this.objects.length
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(ws, message) {
    const data = JSON.parse(message);
    const attachment = ws.deserializeAttachment();
    const playerId = attachment?.playerId;
    
    if (!playerId || !this.players[playerId]) return;
    
    const player = this.players[playerId];
    
    if (data.type === 'ping') {
      const now = Date.now();
      const ping = now - (attachment.lastPingTime || now);
      player.ping = ping;
      
      ws.send(JSON.stringify({
        type: 'pong',
        ping: ping,
        timestamp: now,
        serverTime: now
      }));
      
      return;
    }
    
    switch(data.type) {
      case 'move':
        const now = Date.now();
        const deltaTime = Math.min((now - (player.lastMoveTime || now)) / 1000, 0.05);
        player.lastMoveTime = now;
        
        player.rotation = data.rotation || 0;
        
        if (data.keys) {
          const speed = 5.5 * deltaTime;
          let dx = 0, dz = 0;
          
          if (data.keys.w) { dx += Math.sin(player.rotation) * speed; dz += Math.cos(player.rotation) * speed; }
          if (data.keys.s) { dx -= Math.sin(player.rotation) * speed; dz -= Math.cos(player.rotation) * speed; }
          if (data.keys.a) { dx += Math.sin(player.rotation - Math.PI/2) * speed * 0.8; dz += Math.cos(player.rotation - Math.PI/2) * speed * 0.8; }
          if (data.keys.d) { dx += Math.sin(player.rotation + Math.PI/2) * speed * 0.8; dz += Math.cos(player.rotation + Math.PI/2) * speed * 0.8; }
          
          // Полностью доверяем клиенту для плавности
          if (data.predictedX !== undefined && data.predictedZ !== undefined) {
            const dist = Math.hypot(data.predictedX - player.x, data.predictedZ - player.z);
            if (dist < 1.0) {
              // Мягкая коррекция
              player.x += (data.predictedX - player.x) * 0.15;
              player.z += (data.predictedZ - player.z) * 0.15;
            } else {
              // При большом расхождении используем серверный расчет
              player.x += dx;
              player.z += dz;
            }
          } else {
            player.x += dx;
            player.z += dz;
          }
          
          player.speedX = dx / deltaTime;
          player.speedZ = dz / deltaTime;
        }
        
        player.x = Math.max(-30, Math.min(30, player.x));
        player.z = Math.max(-30, Math.min(30, player.z));
        break;
        
      case 'shoot':
        const rayX = player.x + Math.sin(player.rotation) * 3;
        const rayZ = player.z + Math.cos(player.rotation) * 3;
        
        this.objects = this.objects.map(obj => {
          const dx = obj.x - rayX;
          const dz = obj.z - rayZ;
          if (Math.abs(dx) < 2 && Math.abs(dz) < 2 && obj.h > 0) {
            return { ...obj, h: obj.h - 0.5 };
          }
          return obj;
        });
        break;
        
      case 'chat':
        const name = playerId.slice(0, 6);
        const chatMessage = {
          type: 'chat',
          id: playerId,
          name: name,
          text: data.text,
          timestamp: Date.now()
        };
        
        const msgStr = JSON.stringify(chatMessage);
        this.ctx.getWebSockets().forEach(wsClient => {
          try {
            wsClient.send(msgStr);
          } catch(e) {}
        });
        break;
    }
    
    await this.storage.put('state', {
      players: this.players,
      objects: this.objects
    });
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
      } catch(e) {}
    });
  }

  webSocketClose(ws) {
    const attachment = ws.deserializeAttachment();
    if (attachment?.playerId) {
      delete this.players[attachment.playerId];
      
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
