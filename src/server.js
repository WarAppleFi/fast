export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Map();
    this.players = new Map();
    this.lastUpdateTime = 0;
    this.tickRate = 30; // Умеренный tick rate
    this.heartbeat = null;
    this.tickCounter = 0;
    this.worldWidth = 800;
    this.worldHeight = 600;
  }

  async fetch(request) {
    if (request.headers.get('upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const id = crypto.randomUUID().slice(0, 8);

    server.accept();

    // Инициализация игрока с предсказуемой физикой
    const player = {
      id,
      x: Math.random() * 700 + 50,
      y: Math.random() * 500 + 50,
      vx: 0,
      vy: 0,
      speed: 4,
      direction: { dx: 0, dy: 0 },
      lastInputTime: Date.now()
    };

    this.clients.set(id, { ws: server, lastInput: null });
    this.players.set(id, player);

    // Обработка сообщений от клиента
    server.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        
        if (msg.type === 'input') {
          const clientData = this.clients.get(id);
          if (clientData) {
            // Сохраняем входные данные
            clientData.lastInput = {
              tick: msg.tick || this.tickCounter,
              dx: Math.max(-1, Math.min(1, msg.dx || 0)),
              dy: Math.max(-1, Math.min(1, msg.dy || 0)),
              timestamp: Date.now()
            };
            
            const p = this.players.get(id);
            if (p) {
              // Обновляем направление
              p.direction.dx = clientData.lastInput.dx;
              p.direction.dy = clientData.lastInput.dy;
              
              // Прямое управление скоростью (без резких скачков)
              const targetVx = clientData.lastInput.dx * p.speed;
              const targetVy = clientData.lastInput.dy * p.speed;
              
              // Плавное изменение скорости
              const smoothing = 0.3;
              p.vx += (targetVx - p.vx) * smoothing;
              p.vy += (targetVy - p.vy) * smoothing;
              
              p.lastInputTime = Date.now();
            }
          }
        } else if (msg.type === 'ping') {
          server.send(JSON.stringify({ 
            type: 'pong', 
            time: Date.now(),
            serverTick: this.tickCounter 
          }));
        }
      } catch (e) {
        // игнорируем битые сообщения
      }
    });

    server.addEventListener('close', () => {
      this.clients.delete(id);
      this.players.delete(id);
      
      this.broadcast({ 
        type: 'leave', 
        id, 
        time: Date.now() 
      });
      
      if (this.clients.size === 0 && this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
      }
    });

    // Отправляем текущее состояние
    const initPlayers = Array.from(this.players.values()).map(p => ({
      id: p.id,
      x: p.x,
      y: p.y,
      vx: p.vx,
      vy: p.vy,
      direction: p.direction
    }));

    server.send(JSON.stringify({
      type: 'init',
      id,
      players: initPlayers,
      tick: this.tickCounter,
      serverTime: Date.now()
    }));

    // Оповещаем о новом игроке
    this.broadcast({
      type: 'join',
      id,
      x: player.x,
      y: player.y,
      vx: player.vx,
      vy: player.vy,
      direction: player.direction,
      time: Date.now()
    }, id);

    // Запускаем игровой цикл
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        this.gameLoop();
      }, 1000 / this.tickRate);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  gameLoop() {
    this.tickCounter++;
    const now = Date.now();
    
    // Обновляем физику для всех игроков
    for (const [id, player] of this.players) {
      // Применяем скорость
      player.x += player.vx;
      player.y += player.vy;
      
      // Границы карты
      player.x = Math.max(20, Math.min(this.worldWidth - 20, player.x));
      player.y = Math.max(20, Math.min(this.worldHeight - 20, player.y));
      
      // Проверяем, был ли недавно ввод
      const clientData = this.clients.get(id);
      if (clientData && clientData.lastInput) {
        const timeSinceInput = now - clientData.lastInput.timestamp;
        if (timeSinceInput > 100) {
          // Плавное торможение
          const friction = 0.9;
          player.vx *= friction;
          player.vy *= friction;
          if (Math.abs(player.vx) < 0.01) player.vx = 0;
          if (Math.abs(player.vy) < 0.01) player.vy = 0;
        }
      }
    }

    // Отправляем состояние всем клиентам
    const state = {
      type: 'state',
      tick: this.tickCounter,
      time: now,
      players: Array.from(this.players.values()).map(p => ({
        id: p.id,
        x: p.x,
        y: p.y,
        vx: p.vx,
        vy: p.vy,
        direction: p.direction
      }))
    };

    this.broadcast(state);
  }

  broadcast(obj, exceptId) {
    const text = JSON.stringify(obj);
    for (const [pid, data] of this.clients) {
      if (pid === exceptId) continue;
      try { 
        if (data.ws.readyState === 1) {
          data.ws.send(text); 
        }
      } catch (e) {}
    }
  }
}

export default {
  async fetch(request, env) {
    const id = env.GAME.idFromName('global');
    const obj = env.GAME.get(id);
    return obj.fetch(request);
  }
};
