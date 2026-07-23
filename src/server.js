// ===== DURABLE OBJECT =====
export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.players = {};
    this.objects = [];
    this.id = state.id.toString();
    this.tickInterval = null;
    
    // Создаём несколько кубов на карте
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
  }

  async fetch(request) {
    const url = new URL(request.url);
    
    // WebSocket upgrade
    if (url.pathname === '/ws') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      
      this.state.acceptWebSocket(server);
      
      // Добавляем игрока
      const playerId = crypto.randomUUID();
      this.players[playerId] = {
        id: playerId,
        x: (Math.random() - 0.5) * 20,
        z: (Math.random() - 0.5) * 20,
        y: 0.5,
        rotation: 0,
        health: 100
      };
      
      server.serializeAttachment({ playerId });
      
      // Отправляем текущее состояние новому игроку
      server.send(JSON.stringify({
        type: 'init',
        playerId,
        players: this.players,
        objects: this.objects
      }));
      
      // Запускаем игровой тик (если ещё не запущен)
      if (!this.tickInterval) {
        this.tickInterval = setInterval(() => this.gameTick(), 50); // 20 FPS
      }
      
      return new Response(null, { status: 101, webSocket: client });
    }
    
    return new Response('Not found', { status: 404 });
  }

  // Обработка сообщений от клиента
  async webSocketMessage(ws, message) {
    const data = JSON.parse(message);
    const attachment = ws.deserializeAttachment();
    const playerId = attachment?.playerId;
    
    if (!playerId || !this.players[playerId]) return;
    
    const player = this.players[playerId];
    
    switch(data.type) {
      case 'move':
        // Поворот
        player.rotation = data.rotation || 0;
        
        // Движение
        if (data.keys) {
          const speed = 0.15;
          let dx = 0, dz = 0;
          if (data.keys.w) { dx += Math.sin(player.rotation) * speed; dz += Math.cos(player.rotation) * speed; }
          if (data.keys.s) { dx -= Math.sin(player.rotation) * speed; dz -= Math.cos(player.rotation) * speed; }
          if (data.keys.a) { dx += Math.sin(player.rotation - Math.PI/2) * speed; dz += Math.cos(player.rotation - Math.PI/2) * speed; }
          if (data.keys.d) { dx += Math.sin(player.rotation + Math.PI/2) * speed; dz += Math.cos(player.rotation + Math.PI/2) * speed; }
          
          player.x += dx;
          player.z += dz;
          
          // Границы карты
          player.x = Math.max(-30, Math.min(30, player.x));
          player.z = Math.max(-30, Math.min(30, player.z));
        }
        break;
        
      case 'shoot':
        // Простая стрельба: проверяем попадание по кубам
        const rayX = player.x + Math.sin(player.rotation) * 3;
        const rayZ = player.z + Math.cos(player.rotation) * 3;
        
        this.objects = this.objects.map(obj => {
          const dx = obj.x - rayX;
          const dz = obj.z - rayZ;
          if (Math.abs(dx) < 2 && Math.abs(dz) < 2 && obj.h > 0) {
            return { ...obj, h: obj.h - 0.5 }; // Уменьшаем высоту куба
          }
          return obj;
        });
        break;
    }
  }

  // Игровой тик - рассылаем состояние всем
  gameTick() {
    const state = {
      type: 'state',
      players: this.players,
      objects: this.objects
    };
    
    const message = JSON.stringify(state);
    this.state.getWebSockets().forEach(ws => {
      try {
        ws.send(message);
      } catch(e) {}
    });
  }

  webSocketClose(ws) {
    const attachment = ws.deserializeAttachment();
    if (attachment?.playerId) {
      delete this.players[attachment.playerId];
    }
    
    // Если игроков нет - останавливаем тик
    if (Object.keys(this.players).length === 0) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }
}

// ===== WORKER =====
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Создаём/получаем комнату
    const id = env.GAME_ROOM.idFromName('main');
    const room = env.GAME_ROOM.get(id);
    
    // Проксируем запрос в DO
    return room.fetch(request);
  }
};
