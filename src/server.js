export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Map(); // id -> {ws, lastInput}
    this.players = new Map(); // id -> playerData
    this.inputs = []; // история входных данных для реконсиляции
    this.lastUpdateTime = 0;
    this.tickRate = 20; // 20 тиков в секунду
    this.heartbeat = null;
    this.tickCounter = 0;
  }

  async fetch(request) {
    if (request.headers.get('upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const id = crypto.randomUUID().slice(0, 8);

    server.accept();

    // Инициализация игрока
    const player = {
      id,
      x: Math.random() * 700 + 50,
      y: Math.random() * 500 + 50,
      vx: 0,
      vy: 0,
      speed: 3,
      direction: { dx: 0, dy: 0 },
      lastInputTime: Date.now(),
      spawnTime: Date.now()
    };

    this.clients.set(id, { ws: server, lastInput: null, lastProcessedTick: 0 });
    this.players.set(id, player);

    // Обработка сообщений от клиента
    server.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        
        if (msg.type === 'input') {
          // Сохраняем входящие команды
          const clientData = this.clients.get(id);
          if (clientData) {
            clientData.lastInput = {
              tick: msg.tick || this.tickCounter,
              dx: msg.dx || 0,
              dy: msg.dy || 0,
              timestamp: Date.now()
            };
            
            // Немедленно обновляем направление для плавности
            const p = this.players.get(id);
            if (p) {
              p.direction.dx = msg.dx || 0;
              p.direction.dy = msg.dy || 0;
              
              // Если есть движение, устанавливаем скорость
              if (msg.dx !== 0 || msg.dy !== 0) {
                const len = Math.sqrt(msg.dx * msg.dx + msg.dy * msg.dy);
                p.vx = (msg.dx / len) * p.speed;
                p.vy = (msg.dy / len) * p.speed;
              } else {
                p.vx = 0;
                p.vy = 0;
              }
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
      
      // Оповещаем всех об уходе
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
    server.send(JSON.stringify({
      type: 'init',
      id,
      players: Array.from(this.players.values()).map(p => ({
        id: p.id,
        x: p.x,
        y: p.y,
        vx: p.vx,
        vy: p.vy,
        direction: p.direction
      })),
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
    
    // Обновляем физику для всех игроков
    for (const [id, player] of this.players) {
      // Применяем текущую скорость
      player.x += player.vx;
      player.y += player.vy;
      
      // Границы карты
      player.x = Math.max(20, Math.min(780, player.x));
      player.y = Math.max(20, Math.min(580, player.y));
      
      // Торможение, если нет ввода
      const clientData = this.clients.get(id);
      if (clientData && clientData.lastInput) {
        const timeSinceInput = Date.now() - clientData.lastInput.timestamp;
        if (timeSinceInput > 100) {
          player.vx *= 0.9;
          player.vy *= 0.9;
          if (Math.abs(player.vx) < 0.01) player.vx = 0;
          if (Math.abs(player.vy) < 0.01) player.vy = 0;
        }
      }
    }

    // Отправляем состояние всем клиентам
    const state = {
      type: 'state',
      tick: this.tickCounter,
      time: Date.now(),
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
      try { data.ws.send(text); } catch (e) {}
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
