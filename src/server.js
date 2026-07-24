export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Map();
    this.players = new Map();
    this.bullets = [];
    this.lastUpdateTime = 0;
    this.tickRate = 60; // 60 тиков для шутера
    this.tickInterval = 1000 / 60;
    this.heartbeat = null;
    this.tickCounter = 0;
    this.worldWidth = 800;
    this.worldHeight = 600;
    
    // Буферы для интерполяции
    this.stateHistory = [];
    this.maxHistorySize = 20;
    
    // Снаряды
    this.bulletSpeed = 12;
    this.bulletLife = 60; // 1 секунда при 60 fps
    this.damage = 25;
    this.shootCooldown = 10; // тиков
    
    // Предсказание
    this.clientInputs = new Map(); // Буфер входов для реконсилиации
  }

  async fetch(request) {
    if (request.headers.get('upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const id = crypto.randomUUID().slice(0, 8);

    server.accept();

    const player = {
      id,
      x: Math.random() * 700 + 50,
      y: Math.random() * 500 + 50,
      vx: 0,
      vy: 0,
      speed: 5,
      health: 100,
      maxHealth: 100,
      direction: { dx: 0, dy: 0 },
      angle: 0, // Угол для стрельбы
      shootCooldown: 0,
      lastInputSeq: 0,
      lastProcessedInput: 0,
      lastUpdateTime: Date.now()
    };

    this.clients.set(id, { 
      ws: server, 
      lastInput: null,
      inputHistory: [], // История входов для реконсилиации
      lastAckedTick: 0,
      ping: 0,
      pingHistory: []
    });
    this.players.set(id, player);

    server.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        
        if (msg.type === 'input') {
          const clientData = this.clients.get(id);
          if (!clientData) return;
          
          // Сохраняем все входы с их порядковыми номерами
          const input = {
            seq: msg.seq || clientData.inputHistory.length,
            tick: msg.tick || this.tickCounter,
            dx: Math.max(-1, Math.min(1, msg.dx || 0)),
            dy: Math.max(-1, Math.min(1, msg.dy || 0)),
            angle: msg.angle || 0,
            shooting: msg.shooting || false,
            timestamp: Date.now()
          };
          
          clientData.inputHistory.push(input);
          if (clientData.inputHistory.length > 100) {
            clientData.inputHistory.shift();
          }
          
          // Обновляем последний вход для текущего кадра
          clientData.lastInput = input;
          
          const p = this.players.get(id);
          if (p) {
            p.direction.dx = input.dx;
            p.direction.dy = input.dy;
            p.angle = input.angle;
            
            // Немедленное применение для локальной плавности
            if (input.dx !== 0 || input.dy !== 0) {
              const len = Math.sqrt(input.dx * input.dx + input.dy * input.dy);
              if (len > 0) {
                const normDx = input.dx / len;
                const normDy = input.dy / len;
                const targetVx = normDx * p.speed;
                const targetVy = normDy * p.speed;
                
                // Более агрессивное сглаживание для отзывчивости
                const smoothing = 0.5;
                p.vx += (targetVx - p.vx) * smoothing;
                p.vy += (targetVy - p.vy) * smoothing;
              }
            } else {
              // Быстрое торможение
              p.vx *= 0.85;
              p.vy *= 0.85;
              if (Math.abs(p.vx) < 0.01) p.vx = 0;
              if (Math.abs(p.vy) < 0.01) p.vy = 0;
            }
            
            // Обработка стрельбы
            if (input.shooting && p.shootCooldown <= 0) {
              this.spawnBullet(id, p);
              p.shootCooldown = this.shootCooldown;
            }
          }
        } else if (msg.type === 'ack') {
          // Клиент подтверждает полученные тики
          const clientData = this.clients.get(id);
          if (clientData) {
            clientData.lastAckedTick = msg.tick || 0;
            if (msg.ping) {
              clientData.ping = Date.now() - msg.ping;
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
      this.clientInputs.delete(id);
      
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
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
      vx: Math.round(p.vx * 10) / 10,
      vy: Math.round(p.vy * 10) / 10,
      health: Math.round(p.health),
      angle: Math.round(p.angle * 100) / 100
    }));

    server.send(JSON.stringify({
      type: 'init',
      id,
      players: initPlayers,
      tick: this.tickCounter,
      serverTime: Date.now(),
      worldWidth: this.worldWidth,
      worldHeight: this.worldHeight,
      tickRate: this.tickRate
    }));

    // Оповещаем о новом игроке
    this.broadcast({
      type: 'join',
      id,
      x: player.x,
      y: player.y,
      angle: player.angle,
      health: player.health,
      time: Date.now()
    }, id);

    // Запускаем игровой цикл
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        this.gameLoop();
      }, this.tickInterval);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  spawnBullet(playerId, player) {
    const angle = player.angle || 0;
    const spawnDist = 30;
    const spread = (Math.random() - 0.5) * 0.05; // Минимальный разброс
    
    // Добавляем немного задержки для сетевой компенсации
    const clientData = this.clients.get(playerId);
    const pingCompensation = clientData ? Math.min(clientData.ping / 1000, 0.1) : 0;
    
    this.bullets.push({
      id: crypto.randomUUID().slice(0, 6),
      playerId: playerId,
      x: player.x + Math.cos(angle) * spawnDist,
      y: player.y + Math.sin(angle) * spawnDist,
      vx: Math.cos(angle + spread) * this.bulletSpeed,
      vy: Math.sin(angle + spread) * this.bulletSpeed,
      life: this.bulletLife,
      created: this.tickCounter,
      damage: this.damage,
      size: 4
    });
  }

  gameLoop() {
    const startTime = performance.now();
    this.tickCounter++;
    const now = Date.now();
    
    // Сохраняем состояние для истории
    const stateSnapshot = {
      tick: this.tickCounter,
      players: new Map(Array.from(this.players.entries()).map(([id, p]) => [
        id, 
        { ...p, x: p.x, y: p.y, vx: p.vx, vy: p.vy, health: p.health }
      ]))
    };
    
    this.stateHistory.push(stateSnapshot);
    if (this.stateHistory.length > this.maxHistorySize) {
      this.stateHistory.shift();
    }
    
    // ---- ФАЗА 1: ОБРАБОТКА ВХОДОВ ----
    // Используем предсказание для каждого игрока
    for (const [id, player] of this.players) {
      const clientData = this.clients.get(id);
      if (!clientData) continue;
      
      // Получаем последний вход
      const lastInput = clientData.lastInput;
      
      // Применяем вход с компенсацией пинга
      if (lastInput) {
        // Применяем физику
        if (lastInput.dx !== 0 || lastInput.dy !== 0) {
          const len = Math.sqrt(lastInput.dx * lastInput.dx + lastInput.dy * lastInput.dy);
          if (len > 0) {
            const normDx = lastInput.dx / len;
            const normDy = lastInput.dy / len;
            const targetVx = normDx * player.speed;
            const targetVy = normDy * player.speed;
            
            // Агрессивное сглаживание
            const smoothing = 0.6;
            player.vx += (targetVx - player.vx) * smoothing;
            player.vy += (targetVy - player.vy) * smoothing;
          }
        } else {
          // Торможение
          player.vx *= 0.85;
          player.vy *= 0.85;
          if (Math.abs(player.vx) < 0.01) player.vx = 0;
          if (Math.abs(player.vy) < 0.01) player.vy = 0;
        }
        
        // Стрельба
        if (lastInput.shooting && player.shootCooldown <= 0) {
          this.spawnBullet(id, player);
          player.shootCooldown = this.shootCooldown;
        }
      }
      
      // Обновляем кулдаун
      if (player.shootCooldown > 0) {
        player.shootCooldown--;
      }
      
      // Применяем скорость
      player.x += player.vx;
      player.y += player.vy;
      
      // Границы
      player.x = Math.max(20, Math.min(this.worldWidth - 20, player.x));
      player.y = Math.max(20, Math.min(this.worldHeight - 20, player.y));
    }
    
    // ---- ФАЗА 2: ОБРАБОТКА СНАРЯДОВ ----
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const bullet = this.bullets[i];
      
      // Движение
      bullet.x += bullet.vx;
      bullet.y += bullet.vy;
      bullet.life--;
      
      // Проверка стен
      if (bullet.x < 0 || bullet.x > this.worldWidth || 
          bullet.y < 0 || bullet.y > this.worldHeight) {
        this.bullets.splice(i, 1);
        continue;
      }
      
      // Проверка жизни
      if (bullet.life <= 0) {
        this.bullets.splice(i, 1);
        continue;
      }
      
      // ---- КОЛЛИЗИИ ----
      let hit = false;
      for (const [playerId, player] of this.players) {
        if (playerId === bullet.playerId) continue;
        if (player.health <= 0) continue;
        
        const dx = bullet.x - player.x;
        const dy = bullet.y - player.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        if (dist < 20) { // Хитбокс
          player.health -= bullet.damage;
          hit = true;
          
          // Откидывание
          if (dist > 0) {
            player.x += (dx / dist) * 5;
            player.y += (dy / dist) * 5;
          }
          
          // Смерть
          if (player.health <= 0) {
            this.handlePlayerDeath(playerId, bullet.playerId);
          }
          
          break;
        }
      }
      
      if (hit) {
        this.bullets.splice(i, 1);
      }
    }
    
    // ---- ФАЗА 3: ОТПРАВКА СОСТОЯНИЯ ----
    // Создаем дельту для оптимизации трафика
    const stateDelta = {
      type: 'state',
      tick: this.tickCounter,
      time: now,
      players: {},
      bullets: []
    };
    
    // Отправляем только измененных игроков
    for (const [id, player] of this.players) {
      stateDelta.players[id] = {
        x: Math.round(player.x * 10) / 10,
        y: Math.round(player.y * 10) / 10,
        vx: Math.round(player.vx * 10) / 10,
        vy: Math.round(player.vy * 10) / 10,
        health: Math.round(player.health),
        angle: Math.round(player.angle * 100) / 100
      };
    }
    
    // Отправляем последние 10 снарядов
    for (let i = Math.max(0, this.bullets.length - 20); i < this.bullets.length; i++) {
      const b = this.bullets[i];
      stateDelta.bullets.push({
        id: b.id,
        x: Math.round(b.x * 10) / 10,
        y: Math.round(b.y * 10) / 10,
        playerId: b.playerId
      });
    }
    
    // Отправляем каждому клиенту
    const stateMessage = JSON.stringify(stateDelta);
    for (const [pid, client] of this.clients) {
      if (client.ws.readyState !== 1) continue;
      
      // Добавляем компенсацию пинга для этого клиента
      const ping = client.ping || 0;
      const compensationTicks = Math.round(ping / this.tickInterval);
      
      // Отправляем состояние с учетом пинга
      try {
        client.ws.send(stateMessage);
      } catch (e) {}
    }
    
    // Обновляем метрики
    const elapsed = performance.now() - startTime;
    if (elapsed > 5) {
      // Логируем если тик занимает слишком много времени
    }
  }

  handlePlayerDeath(playerId, killerId) {
    const player = this.players.get(playerId);
    if (!player) return;
    
    // Спавн через 3 секунды
    setTimeout(() => {
      if (this.players.has(playerId)) {
        const p = this.players.get(playerId);
        p.x = Math.random() * 700 + 50;
        p.y = Math.random() * 500 + 50;
        p.vx = 0;
        p.vy = 0;
        p.health = p.maxHealth;
        
        this.broadcast({
          type: 'respawn',
          id: playerId,
          x: p.x,
          y: p.y,
          health: p.health
        });
      }
    }, 3000);
    
    // Уведомление о смерти
    this.broadcast({
      type: 'death',
      playerId: playerId,
      killerId: killerId,
      time: Date.now()
    });
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
    // Поддержка нескольких комнат
    const url = new URL(request.url);
    const roomId = url.searchParams.get('room') || 'global';
    const id = env.GAME.idFromName(roomId);
    const obj = env.GAME.get(id);
    return obj.fetch(request);
  }
};
