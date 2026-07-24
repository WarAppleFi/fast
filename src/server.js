// ===== package.json =====
{
  "name": "game-server",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "@colyseus/colyseus": "^0.15.0",
    "@colyseus/schema": "^2.0.0",
    "ws": "^8.14.2"
  }
}

// ===== src/server.js =====
import { Server, Room } from '@colyseus/colyseus';
import { Schema, type, MapSchema } from '@colyseus/schema';
import { WebSocketTransport } from '@colyseus/ws-transport';

// ===== КЛИЕНТСКАЯ СТРУКТУРА =====
class Player extends Schema {
  constructor() {
    super();
    this.id = '';
    this.x = 0;
    this.z = 0;
    this.y = 0.5;
    this.rotation = 0;
    this.pitch = 0;
    this.health = 100;
    this.speed = 0;
    this.isMoving = false;
    this.lastUpdate = Date.now();
  }
}

// Определение схемы через defineTypes
Player.defineTypes({
  id: 'string',
  x: 'number',
  z: 'number',
  y: 'number',
  rotation: 'number',
  pitch: 'number',
  health: 'number',
  speed: 'number',
  isMoving: 'boolean',
  lastUpdate: 'number'
});

class GameState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();
    this.timestamp = Date.now();
    this.serverTime = Date.now();
    this.objects = [];
  }
}

GameState.defineTypes({
  players: { map: Player },
  timestamp: 'number',
  serverTime: 'number',
  objects: 'array'
});

// ===== ИГРОВАЯ КОМНАТА =====
class GameRoom extends Room {
  constructor() {
    super();
    this.maxClients = 50;
    this.tickRate = 60;
    this.stateSendRate = 20;
    this.lastStateSend = 0;
    this.moveThreshold = 0.001;
    this.objects = [];
    this.lastCleanup = 0;
    this.cleanupInterval = 5000;
  }

  onCreate(options) {
    this.setState(new GameState());
    
    // Генерация объектов
    this.generateObjects();
    
    // Запуск игрового цикла
    this.setSimulationInterval(() => this.update(), 1000 / this.tickRate);
    
    console.log('[GameRoom] Created');
  }

  onJoin(client, options) {
    const player = new Player();
    player.id = client.sessionId;
    player.x = (Math.random() - 0.5) * 10;
    player.z = (Math.random() - 0.5) * 10;
    player.lastUpdate = Date.now();
    
    this.state.players.set(client.sessionId, player);
    
    // Отправка конфига клиенту
    client.send('config', {
      tickRate: this.tickRate,
      interpolationDelay: 50,
      moveThreshold: this.moveThreshold,
      maxPlayers: this.maxClients
    });
    
    console.log(`[GameRoom] Player ${client.sessionId} joined`);
  }

  onLeave(client, consented) {
    this.state.players.delete(client.sessionId);
    console.log(`[GameRoom] Player ${client.sessionId} left`);
  }

  onMessage(client, message) {
    try {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      
      switch (message.type) {
        case 'move':
          this.handleMove(client, player, message);
          break;
        case 'ping':
          this.handlePing(client, player);
          break;
        case 'shoot':
          this.handleShoot(client, player, message);
          break;
        case 'chat':
          this.handleChat(client, player, message);
          break;
      }
    } catch (error) {
      console.error('[GameRoom] Message error:', error);
    }
  }

  handleMove(client, player, data) {
    const now = Date.now();
    const deltaTime = Math.min((now - player.lastUpdate) / 1000, 0.05);
    
    // Максимальная скорость (защита от читов)
    const maxSpeed = 8;
    const maxDelta = maxSpeed * deltaTime;
    
    // Обновление позиции с ограничением
    if (data.x !== undefined && data.z !== undefined) {
      let newX = Math.max(-30, Math.min(30, data.x));
      let newZ = Math.max(-30, Math.min(30, data.z));
      
      const dx = newX - player.x;
      const dz = newZ - player.z;
      const distance = Math.sqrt(dx * dx + dz * dz);
      
      if (distance > maxDelta) {
        const ratio = maxDelta / distance;
        newX = player.x + dx * ratio;
        newZ = player.z + dz * ratio;
      }
      
      // Плавная интерполяция
      const smoothness = 0.3;
      player.x += (newX - player.x) * (1 - smoothness);
      player.z += (newZ - player.z) * (1 - smoothness);
      player.isMoving = distance > 0.01;
      player.speed = distance / deltaTime;
    }
    
    // Обновление поворотов
    if (data.rotation !== undefined) {
      player.rotation = data.rotation;
    }
    
    if (data.pitch !== undefined) {
      player.pitch = Math.max(-Math.PI/2, Math.min(Math.PI/2, data.pitch));
    }
    
    player.lastUpdate = now;
  }

  handlePing(client, player) {
    const now = Date.now();
    client.send('pong', {
      timestamp: now,
      serverTime: now
    });
  }

  handleShoot(client, player, data) {
    // Простая логика стрельбы
    const rayX = player.x + Math.sin(player.rotation) * 3;
    const rayZ = player.z + Math.cos(player.rotation) * 3;
    
    let hit = false;
    let hitTarget = null;
    
    // Проверка попаданий в игроков
    for (const [id, target] of this.state.players) {
      if (id === client.sessionId) continue;
      
      const dx = target.x - rayX;
      const dz = target.z - rayZ;
      const dist = Math.sqrt(dx * dx + dz * dz);
      
      if (dist < 1.5) {
        target.health = Math.max(0, target.health - 10);
        hit = true;
        hitTarget = id;
        break;
      }
    }
    
    // Отправка результата
    this.broadcast('shoot_result', {
      playerId: client.sessionId,
      hit: hit,
      target: hitTarget,
      position: { x: player.x, z: player.z },
      timestamp: Date.now()
    });
  }

  handleChat(client, player, data) {
    const name = client.sessionId.slice(0, 6);
    this.broadcast('chat', {
      id: client.sessionId,
      name: name,
      text: (data.text || '').substring(0, 100),
      timestamp: Date.now()
    });
  }

  update() {
    const now = Date.now();
    
    // Очистка неактивных игроков
    if (now - this.lastCleanup > this.cleanupInterval) {
      this.cleanupPlayers();
      this.lastCleanup = now;
    }
    
    // Отправка состояния
    if (now - this.lastStateSend > 1000 / this.stateSendRate) {
      this.state.timestamp = now;
      this.state.serverTime = now;
      this.lastStateSend = now;
    }
  }

  cleanupPlayers() {
    const now = Date.now();
    const timeout = 30000;
    const toRemove = [];
    
    for (const [id, player] of this.state.players) {
      if (now - player.lastUpdate > timeout) {
        toRemove.push(id);
      }
    }
    
    for (const id of toRemove) {
      this.state.players.delete(id);
    }
    
    if (toRemove.length > 0) {
      console.log(`[Cleanup] Removed ${toRemove.length} inactive players`);
    }
  }

  generateObjects() {
    // Генерация объектов
    this.objects = [];
    const count = 20;
    for (let i = 0; i < count; i++) {
      this.objects.push({
        id: i,
        x: (Math.random() - 0.5) * 40,
        z: (Math.random() - 0.5) * 40,
        y: 1,
        w: 2,
        h: 2 + Math.random() * 3,
        d: 2,
        color: Math.floor(Math.random() * 0xffffff)
      });
    }
    this.state.objects = this.objects;
  }
}

// ===== ОСНОВНОЙ СЕРВЕР =====
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Создаем сервер
    const server = new Server({
      transport: new WebSocketTransport({
        server: {
          handleUpgrade: (request, socket, head) => {
            // Обработка WebSocket апгрейда
            return true;
          }
        }
      })
    });
    
    // Регистрируем комнату
    server.define('game', GameRoom);
    
    // Маршрутизация запросов
    if (url.pathname === '/' || url.pathname === '') {
      return new Response(this.getHTML(), {
        headers: { 'Content-Type': 'text/html' }
      });
    }
    
    if (url.pathname === '/ws') {
      // Обработка WebSocket
      return server.handleUpgrade(request);
    }
    
    if (url.pathname === '/client.js') {
      return new Response(this.getClientJS(), {
        headers: { 'Content-Type': 'application/javascript' }
      });
    }
    
    return new Response('Not Found', { status: 404 });
  },
  
  getHTML() {
    return `
<!DOCTYPE html>
<html>
<head>
  <title>Multiplayer Game</title>
  <style>
    body { margin: 0; background: #1a1a2e; color: white; font-family: Arial; }
    #game { display: block; margin: 20px auto; background: #16213e; border: 2px solid #0f3460; }
    #ui { position: absolute; top: 20px; left: 20px; }
    #status { position: absolute; top: 20px; right: 20px; background: rgba(0,0,0,0.7); padding: 10px; border-radius: 5px; }
    .controls { position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%); text-align: center; color: #aaa; }
  </style>
</head>
<body>
  <div id="status">Connecting...</div>
  <canvas id="game" width="800" height="600"></canvas>
  <div class="controls">WASD - Move | Mouse - Look | Click - Shoot</div>
  
  <script src="https://cdn.jsdelivr.net/npm/colyseus.js@0.15.x/dist/colyseus.js"></script>
  <script src="/client.js"></script>
</body>
</html>`;
  },
  
  getClientJS() {
    return `
// ===== КЛИЕНТСКАЯ ЧАСТЬ =====
class GameClient {
  constructor() {
    this.players = new Map();
    this.localPlayer = null;
    this.interpolationDelay = 50;
    this.serverTime = 0;
    this.lastSendTime = 0;
    this.keys = {};
    this.mouse = { x: 0, y: 0 };
    
    this.setupInput();
    this.connect();
  }
  
  async connect() {
    const host = window.location.origin.replace('http', 'ws');
    
    try {
      this.client = new Colyseus.Client(host);
      this.room = await this.client.joinOrCreate('game');
      console.log('Connected to game');
      
      this.setupListeners();
      this.startGameLoop();
      
      document.getElementById('status').textContent = 'Connected!';
    } catch (error) {
      console.error('Connection error:', error);
      document.getElementById('status').textContent = 'Connection failed!';
    }
  }
  
  setupListeners() {
    // Обработка конфига
    this.room.onMessage('config', (config) => {
      this.interpolationDelay = config.interpolationDelay;
      console.log('Config received:', config);
    });
    
    // Обработка состояния
    this.room.onStateChange((state) => {
      this.handleStateChange(state);
    });
    
    // Обработка сообщений
    this.room.onMessage('pong', (data) => {
      this.handlePong(data);
    });
    
    this.room.onMessage('shoot_result', (data) => {
      this.handleShootResult(data);
    });
    
    this.room.onMessage('chat', (data) => {
      this.handleChat(data);
    });
  }
  
  handleStateChange(state) {
    const now = Date.now();
    
    // Обновление игроков
    for (const [id, playerData] of state.players) {
      let player = this.players.get(id);
      
      if (!player) {
        player = {
          id: id,
          x: playerData.x,
          z: playerData.z,
          y: playerData.y,
          rotation: playerData.rotation,
          pitch: playerData.pitch,
          health: playerData.health,
          isMoving: playerData.isMoving,
          renderX: playerData.x,
          renderZ: playerData.z,
          renderR: playerData.rotation,
          prevX: playerData.x,
          prevZ: playerData.z,
          prevR: playerData.rotation,
          lastUpdate: now
        };
        this.players.set(id, player);
      }
      
      // Сохраняем предыдущие значения для интерполяции
      player.prevX = player.x;
      player.prevZ = player.z;
      player.prevR = player.rotation;
      
      // Обновляем текущие значения
      player.x = playerData.x;
      player.z = playerData.z;
      player.rotation = playerData.rotation;
      player.pitch = playerData.pitch;
      player.health = playerData.health;
      player.isMoving = playerData.isMoving;
      player.lastUpdate = now;
      
      if (id === this.room.sessionId) {
        this.localPlayer = player;
      }
    }
    
    // Удаление игроков, которых нет в состоянии
    for (const [id] of this.players) {
      if (!state.players.has(id)) {
        this.players.delete(id);
      }
    }
  }
  
  handlePong(data) {
    const ping = Date.now() - data.timestamp;
    document.getElementById('status').textContent = \`Ping: \${ping}ms | Players: \${this.players.size}\`;
  }
  
  handleShootResult(data) {
    if (data.hit) {
      console.log('Hit target:', data.target);
    }
  }
  
  handleChat(data) {
    console.log(\`[\${data.name}] \${data.text}\`);
  }
  
  setupInput() {
    // Управление WASD
    document.addEventListener('keydown', (e) => {
      this.keys[e.key.toLowerCase()] = true;
    });
    
    document.addEventListener('keyup', (e) => {
      this.keys[e.key.toLowerCase()] = false;
    });
    
    // Управление мышью
    document.addEventListener('mousemove', (e) => {
      const canvas = document.getElementById('game');
      const rect = canvas.getBoundingClientRect();
      this.mouse.x = (e.clientX - rect.left) / canvas.width;
      this.mouse.y = (e.clientY - rect.top) / canvas.height;
    });
    
    // Стрельба
    document.addEventListener('click', () => {
      this.shoot();
    });
  }
  
  startGameLoop() {
    this.gameLoop();
  }
  
  gameLoop() {
    const now = Date.now();
    
    // Обновление локального игрока
    this.updateLocalPlayer();
    
    // Интерполяция позиций
    this.interpolatePlayers(now);
    
    // Отрисовка
    this.render();
    
    requestAnimationFrame(() => this.gameLoop());
  }
  
  updateLocalPlayer() {
    if (!this.localPlayer || !this.room) return;
    
    const speed = 5;
    let dx = 0;
    let dz = 0;
    
    if (this.keys['w']) dz -= speed;
    if (this.keys['s']) dz += speed;
    if (this.keys['a']) dx -= speed;
    if (this.keys['d']) dx += speed;
    
    if (dx !== 0 || dz !== 0) {
      // Нормализация для диагонального движения
      const len = Math.sqrt(dx*dx + dz*dz);
      if (len > speed) {
        dx = dx / len * speed;
        dz = dz / len * speed;
      }
      
      const dt = 0.016; // ~60fps
      this.localPlayer.x += dx * dt;
      this.localPlayer.z += dz * dt;
      
      // Ограничение карты
      this.localPlayer.x = Math.max(-30, Math.min(30, this.localPlayer.x));
      this.localPlayer.z = Math.max(-30, Math.min(30, this.localPlayer.z));
      
      // Обновление поворота
      const targetRot = Math.atan2(this.mouse.x - 0.5, this.mouse.y - 0.5);
      this.localPlayer.rotation = targetRot;
      
      // Отправка движения на сервер
      this.sendMovement();
    }
  }
  
  sendMovement() {
    const now = Date.now();
    if (now - this.lastSendTime < 50) return; // 20 раз в секунду
    
    if (this.localPlayer) {
      this.room.send('move', {
        x: this.localPlayer.x,
        z: this.localPlayer.z,
        rotation: this.localPlayer.rotation,
        pitch: this.localPlayer.pitch
      });
      this.lastSendTime = now;
    }
  }
  
  interpolatePlayers(now) {
    const renderTime = now - this.interpolationDelay;
    
    for (const [id, player] of this.players) {
      if (!player.prevX) continue;
      
      const timeDiff = renderTime - player.lastUpdate;
      const interpolationFactor = Math.max(0, Math.min(1, timeDiff / 50));
      
      // Плавная интерполяция
      player.renderX = player.prevX + (player.x - player.prevX) * interpolationFactor;
      player.renderZ = player.prevZ + (player.z - player.prevZ) * interpolationFactor;
      player.renderR = player.prevR + (player.rotation - player.prevR) * interpolationFactor;
    }
  }
  
  shoot() {
    if (this.room && this.localPlayer) {
      this.room.send('shoot', {
        x: this.localPlayer.x,
        z: this.localPlayer.z,
        rotation: this.localPlayer.rotation
      });
    }
  }
  
  render() {
    const canvas = document.getElementById('game');
    const ctx = canvas.getContext('2d');
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Отрисовка игроков
    for (const [id, player] of this.players) {
      const x = canvas.width/2 + (player.renderX - (this.localPlayer?.x || 0)) * 20;
      const z = canvas.height/2 + (player.renderZ - (this.localPlayer?.z || 0)) * 20;
      
      // Игрок
      ctx.beginPath();
      ctx.arc(x, z, 10, 0, Math.PI * 2);
      
      if (id === this.room?.sessionId) {
        ctx.fillStyle = '#00ff00';
        ctx.strokeStyle = '#00ff88';
      } else {
        ctx.fillStyle = '#ff4444';
        ctx.strokeStyle = '#ff6666';
      }
      
      ctx.fill();
      ctx.stroke();
      
      // Направление
      ctx.beginPath();
      ctx.moveTo(x, z);
      ctx.lineTo(
        x + Math.sin(player.renderR) * 20,
        z + Math.cos(player.renderR) * 20
      );
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
      
      // Имя и здоровье
      ctx.fillStyle = '#ffffff';
      ctx.font = '12px Arial';
      ctx.fillText(id.slice(0, 6), x - 20, z - 20);
      ctx.fillText(\`HP: \${player.health}\`, x - 20, z - 35);
    }
  }
}

// ===== ЗАПУСК =====
const game = new GameClient();
window.game = game;`;
  }
};
