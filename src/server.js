export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Map();
    this.players = new Map();
    this.lastUpdateTime = 0;
    this.tickRate = 60; // Увеличен до 60 тиков для плавности
    this.heartbeat = null;
    this.tickCounter = 0;
    this.worldWidth = 800;
    this.worldHeight = 600;
    this.interpolationBuffer = new Map(); // Для сглаживания
  }

  async fetch(request) {
    if (request.headers.get('upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const id = crypto.randomUUID().slice(0, 8);

    server.accept();

    // Инициализация игрока с улучшенной физикой
    const player = {
      id,
      x: Math.random() * 700 + 50,
      y: Math.random() * 500 + 50,
      vx: 0,
      vy: 0,
      speed: 4.5, // Чуть быстрее
      maxSpeed: 6.5,
      acceleration: 0.4,
      friction: 0.92,
      direction: { dx: 0, dy: 0 },
      lastInputTime: Date.now(),
      spawnTime: Date.now(),
      smoothX: 0,
      smoothY: 0,
      lastUpdate: Date.now()
    };

    this.clients.set(id, { ws: server, lastInput: null, lastProcessedTick: 0, ping: 0 });
    this.players.set(id, player);

    // Обработка сообщений от клиента
    server.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        
        if (msg.type === 'input') {
          const clientData = this.clients.get(id);
          if (clientData) {
            // Сохраняем входные данные с временной меткой
            clientData.lastInput = {
              tick: msg.tick || this.tickCounter,
              dx: Math.max(-1, Math.min(1, msg.dx || 0)),
              dy: Math.max(-1, Math.min(1, msg.dy || 0)),
              timestamp: Date.now()
            };
            
            // Немедленно обновляем направление
            const p = this.players.get(id);
            if (p) {
              p.direction.dx = clientData.lastInput.dx;
              p.direction.dy = clientData.lastInput.dy;
              
              // Устанавливаем скорость на основе ввода
              const dx = clientData.lastInput.dx;
              const dy = clientData.lastInput.dy;
              const len = Math.sqrt(dx * dx + dy * dy);
              
              if (len > 0.01) {
                // Плавное ускорение
                const targetSpeed = Math.min(p.speed + len * 0.5, p.maxSpeed);
                const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
                if (speed < targetSpeed) {
                  const accel = p.acceleration * (1 + len * 0.3);
                  p.vx += (dx / len) * accel;
                  p.vy += (dy / len) * accel;
                }
              } else {
                // Торможение
                p.vx *= p.friction;
                p.vy *= p.friction;
                if (Math.abs(p.vx) < 0.01) p.vx = 0;
                if (Math.abs(p.vy) < 0.01) p.vy = 0;
              }
            }
          }
        } else if (msg.type === 'ping') {
          // Отвечаем на пинг для измерения задержки
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
      this.interpolationBuffer.delete(id);
      
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

    // Отправляем текущее состояние с сглаженными данными
    const initPlayers = Array.from(this.players.values()).map(p => ({
      id: p.id,
      x: p.x,
      y: p.y,
      vx: p.vx,
      vy: p.vy,
      direction: p.direction,
      smoothX: p.x,
      smoothY: p.y
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

    // Запускаем игровой цикл с более высокой частотой
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
      // Ограничиваем максимальную скорость
      const speed = Math.sqrt(player.vx * player.vx + player.vy * player.vy);
      if (speed > player.maxSpeed) {
        player.vx = (player.vx / speed) * player.maxSpeed;
        player.vy = (player.vy / speed) * player.maxSpeed;
      }
      
      // Применяем скорость
      player.x += player.vx;
      player.y += player.vy;
      
      // Границы карты с отскоком
      if (player.x < 20) { player.x = 20; player.vx *= -0.3; }
      if (player.x > this.worldWidth - 20) { player.x = this.worldWidth - 20; player.vx *= -0.3; }
      if (player.y < 20) { player.y = 20; player.vy *= -0.3; }
      if (player.y > this.worldHeight - 20) { player.y = this.worldHeight - 20; player.vy *= -0.3; }
      
      // Торможение, если нет ввода
      const clientData = this.clients.get(id);
      if (clientData && clientData.lastInput) {
        const timeSinceInput = now - clientData.lastInput.timestamp;
        if (timeSinceInput > 50) { // 50ms без ввода - начинаем торможение
          const friction = Math.max(0.9 - (timeSinceInput - 50) / 1000 * 0.05, 0.8);
          player.vx *= friction;
          player.vy *= friction;
          if (Math.abs(player.vx) < 0.01) player.vx = 0;
          if (Math.abs(player.vy) < 0.01) player.vy = 0;
        }
      }
      
      // Сохраняем время обновления
      player.lastUpdate = now;
    }

    // Отправляем состояние всем клиентам с интерполяционными данными
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
        direction: p.direction,
        smoothX: p.smoothX || p.x,
        smoothY: p.smoothY || p.y
      }))
    };

    this.broadcast(state);
  }

  broadcast(obj, exceptId) {
    const text = JSON.stringify(obj);
    for (const [pid, data] of this.clients) {
      if (pid === exceptId) continue;
      try { 
        if (data.ws.readyState === 1) { // OPEN
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
