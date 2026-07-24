export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Map();
    this.players = new Map();
    this.bullets = [];
    this.lastUpdateTime = 0;
    this.tickRate = 60;
    this.tickInterval = 1000 / 60;
    this.heartbeat = null;
    this.tickCounter = 0;
    this.worldWidth = 800;
    this.worldHeight = 600;
    
    this.stateHistory = [];
    this.maxHistorySize = 20;
    
    this.bulletSpeed = 12;
    this.bulletLife = 60;
    this.damage = 25;
    this.shootCooldown = 10;
    this.clientInputs = new Map();
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
      angle: 0,
      shootCooldown: 0,
      lastInputSeq: 0,
      lastProcessedInput: 0,
      lastUpdateTime: Date.now(),
      // Добавляем целевые скорости для плавности
      targetVx: 0,
      targetVy: 0
    };

    this.clients.set(id, { 
      ws: server, 
      lastInput: null,
      inputHistory: [],
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
          
          clientData.lastInput = input;
          
          const p = this.players.get(id);
          if (p) {
            p.direction.dx = input.dx;
            p.direction.dy = input.dy;
            p.angle = input.angle;
            
            // Вычисляем целевые скорости
            if (input.dx !== 0 || input.dy !== 0) {
              const len = Math.sqrt(input.dx * input.dx + input.dy * input.dy);
              if (len > 0) {
                const normDx = input.dx / len;
                const normDy = input.dy / len;
                p.targetVx = normDx * p.speed;
                p.targetVy = normDy * p.speed;
              }
            } else {
              p.targetVx = 0;
              p.targetVy = 0;
            }
            
            // Обработка стрельбы
            if (input.shooting && p.shootCooldown <= 0) {
              this.spawnBullet(id, p);
              p.shootCooldown = this.shootCooldown;
            }
          }
        } else if (msg.type === 'ack') {
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

    this.broadcast({
      type: 'join',
      id,
      x: player.x,
      y: player.y,
      angle: player.angle,
      health: player.health,
      time: Date.now()
    }, id);

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
    const spread = (Math.random() - 0.5) * 0.05;
    
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
    
    // ---- ФАЗА 1: ОБНОВЛЕНИЕ ФИЗИКИ ----
    for (const [id, player] of this.players) {
      // Плавно приближаем текущую скорость к целевой
      const smoothing = 0.3; // Меньше = плавнее
      player.vx += (player.targetVx - player.vx) * smoothing;
      player.vy += (player.targetVy - player.vy) * smoothing;
      
      // Если скорость очень маленькая, обнуляем
      if (Math.abs(player.vx) < 0.01) player.vx = 0;
      if (Math.abs(player.vy) < 0.01) player.vy = 0;
      
      // Применяем скорость
      player.x += player.vx;
      player.y += player.vy;
      
      // Границы
      player.x = Math.max(20, Math.min(this.worldWidth - 20, player.x));
      player.y = Math.max(20, Math.min(this.worldHeight - 20, player.y));
      
      // Обновляем кулдаун
      if (player.shootCooldown > 0) {
        player.shootCooldown--;
      }
    }
    
    // ---- ФАЗА 2: ОБРАБОТКА СНАРЯДОВ ----
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const bullet = this.bullets[i];
      
      bullet.x += bullet.vx;
      bullet.y += bullet.vy;
      bullet.life--;
      
      if (bullet.x < 0 || bullet.x > this.worldWidth || 
          bullet.y < 0 || bullet.y > this.worldHeight) {
        this.bullets.splice(i, 1);
        continue;
      }
      
      if (bullet.life <= 0) {
        this.bullets.splice(i, 1);
        continue;
      }
      
      let hit = false;
      for (const [playerId, player] of this.players) {
        if (playerId === bullet.playerId) continue;
        if (player.health <= 0) continue;
        
        const dx = bullet.x - player.x;
        const dy = bullet.y - player.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        if (dist < 20) {
          player.health -= bullet.damage;
          hit = true;
          
          if (dist > 0) {
            player.x += (dx / dist) * 5;
            player.y += (dy / dist) * 5;
          }
          
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
    
    const stateDelta = {
      type: 'state',
      tick: this.tickCounter,
      time: now,
      players: {},
      bullets: []
    };
    
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
    
    for (let i = Math.max(0, this.bullets.length - 20); i < this.bullets.length; i++) {
      const b = this.bullets[i];
      stateDelta.bullets.push({
        id: b.id,
        x: Math.round(b.x * 10) / 10,
        y: Math.round(b.y * 10) / 10,
        playerId: b.playerId
      });
    }
    
    const stateMessage = JSON.stringify(stateDelta);
    for (const [pid, client] of this.clients) {
      if (client.ws.readyState !== 1) continue;
      try {
        client.ws.send(stateMessage);
      } catch (e) {}
    }
    
    const elapsed = performance.now() - startTime;
    if (elapsed > 5) {
      // Логируем если тик занимает слишком много времени
    }
  }

  handlePlayerDeath(playerId, killerId) {
    const player = this.players.get(playerId);
    if (!player) return;
    
    setTimeout(() => {
      if (this.players.has(playerId)) {
        const p = this.players.get(playerId);
        p.x = Math.random() * 700 + 50;
        p.y = Math.random() * 500 + 50;
        p.vx = 0;
        p.vy = 0;
        p.targetVx = 0;
        p.targetVy = 0;
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
    const url = new URL(request.url);
    const roomId = url.searchParams.get('room') || 'global';
    const id = env.GAME.idFromName(roomId);
    const obj = env.GAME.get(id);
    return obj.fetch(request);
  }
};
