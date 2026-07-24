// ===== src/server.js =====
// РАБОТАЕТ В CLOUDFLARE WORKERS БЕЗ ВНЕШНИХ ЗАВИСИМОСТЕЙ

/**
 * DURABLE OBJECT - ИГРОВАЯ КОМНАТА
 */
export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.storage = ctx.storage;
    this.id = ctx.id.toString();
    
    // ===== ОПТИМИЗИРОВАННЫЕ СТРУКТУРЫ =====
    this.players = new Map();
    this.objects = [];
    this.wsMap = new Map(); // ws -> playerId
    
    // ===== НАСТРОЙКИ ДЛЯ ПЛАВНОГО ДВИЖЕНИЯ =====
    this.config = {
      tickRate: 30,        // тиков в секунду
      stateSendRate: 20,   // полных состояний в секунду
      maxPlayers: 50,
      maxSpeed: 6,         // максимальная скорость
      interpolationDelay: 50, // мс для интерполяции
      moveThreshold: 0.001,
      cleanupInterval: 5000
    };
    
    // ===== СОСТОЯНИЕ =====
    this.lastTickTime = Date.now();
    this.tickCount = 0;
    this.currentTPS = 0;
    this.timer = null;
    this.lastStateSend = 0;
    this.lastCleanup = 0;
    
    // ===== БУФЕР ОБНОВЛЕНИЙ =====
    this.updateBuffer = [];
    
    // Инициализация
    this.initialize();
  }

  // ===== ИНИЦИАЛИЗАЦИЯ =====
  async initialize() {
    try {
      const saved = await this.storage.get('state');
      if (saved && saved.objects) {
        this.objects = saved.objects;
      } else {
        this.generateObjects();
        await this.saveState();
      }
    } catch (error) {
      console.error('[Init] Error:', error);
      this.generateObjects();
    }
    
    this.startLoop();
    console.log('[GameRoom] Ready');
  }

  generateObjects() {
    this.objects = [];
    for (let i = 0; i < 20; i++) {
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
  }

  async saveState() {
    try {
      await this.storage.put('state', {
        objects: this.objects,
        timestamp: Date.now()
      });
    } catch (error) {
      console.error('[Save] Error:', error);
    }
  }

  // ===== ИГРОВОЙ ЦИКЛ =====
  startLoop() {
    if (this.timer) {
      clearInterval(this.timer);
    }
    
    this.timer = setInterval(() => this.tick(), 1000 / this.config.tickRate);
  }

  tick() {
    const now = Date.now();
    this.tickCount++;
    
    // Расчет TPS
    if (now - this.lastTickTime >= 1000) {
      this.currentTPS = this.tickCount;
      this.tickCount = 0;
      this.lastTickTime = now;
    }
    
    // Обработка буфера обновлений
    this.processUpdates();
    
    // Отправка состояния
    if (now - this.lastStateSend > 1000 / this.config.stateSendRate) {
      this.sendState();
      this.lastStateSend = now;
    }
    
    // Очистка
    if (now - this.lastCleanup > this.config.cleanupInterval) {
      this.cleanupPlayers();
      this.lastCleanup = now;
    }
    
    // Остановка если нет игроков
    if (this.players.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ===== ОБРАБОТКА ЗАПРОСОВ =====
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    try {
      if (path === '/ws') {
        return this.handleWebSocket();
      }
      
      if (path === '/stats') {
        return this.handleStats();
      }
      
      if (path === '/reset') {
        return this.handleReset();
      }
      
      return new Response('Not found', { status: 404 });
    } catch (error) {
      console.error('[Fetch] Error:', error);
      return new Response('Error', { status: 500 });
    }
  }

  // ===== WEBSOCKET =====
  async handleWebSocket() {
    if (this.players.size >= this.config.maxPlayers) {
      return new Response('Server full', { status: 429 });
    }
    
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    
    this.ctx.acceptWebSocket(server);
    
    // Создаем игрока
    const playerId = crypto.randomUUID();
    const player = {
      id: playerId,
      x: (Math.random() - 0.5) * 10,
      z: (Math.random() - 0.5) * 10,
      y: 0.5,
      rotation: 0,
      pitch: 0,
      health: 100,
      // Для интерполяции
      prevX: 0,
      prevZ: 0,
      prevR: 0,
      targetX: 0,
      targetZ: 0,
      // Время
      lastUpdate: Date.now(),
      lastMoveTime: Date.now(),
      lastActivity: Date.now(),
      connectedAt: Date.now()
    };
    
    this.players.set(playerId, player);
    this.wsMap.set(server, playerId);
    
    await this.saveState();
    
    // ===== ОТПРАВКА ИНИЦИАЛИЗАЦИИ =====
    const initData = {
      type: 'init',
      playerId: playerId,
      players: this.serializePlayers(),
      objects: this.objects,
      serverTime: Date.now(),
      config: {
        tickRate: this.config.tickRate,
        interpolationDelay: this.config.interpolationDelay,
        maxSpeed: this.config.maxSpeed
      }
    };
    
    server.send(JSON.stringify(initData));
    
    // Уведомляем других
    this.broadcastToOthers(server, {
      type: 'player_joined',
      id: playerId,
      player: {
        x: player.x,
        z: player.z,
        rotation: player.rotation,
        health: player.health
      }
    });
    
    console.log(`[WS] Player ${playerId} connected`);
    
    return new Response(null, { status: 101, webSocket: client });
  }

  // ===== ОБРАБОТКА СООБЩЕНИЙ =====
  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message);
      const playerId = this.wsMap.get(ws);
      
      if (!playerId) {
        ws.close(1000, 'Invalid');
        return;
      }
      
      const player = this.players.get(playerId);
      if (!player) {
        ws.close(1000, 'Not found');
        return;
      }
      
      const now = Date.now();
      player.lastActivity = now;
      
      switch (data.type) {
        case 'move':
          this.handleMove(player, data, now);
          break;
        case 'ping':
          this.handlePing(ws, player, now);
          break;
        case 'shoot':
          this.handleShoot(player, data, now);
          break;
        default:
          console.log('[WS] Unknown type:', data.type);
      }
    } catch (error) {
      console.error('[WS] Message error:', error);
    }
  }

  // ===== КЛЮЧЕВОЙ МЕТОД - ПЛАВНОЕ ДВИЖЕНИЕ =====
  handleMove(player, data, now) {
    const deltaTime = Math.min((now - player.lastMoveTime) / 1000, 0.05);
    player.lastMoveTime = now;
    
    // Сохраняем для интерполяции
    player.prevX = player.x;
    player.prevZ = player.z;
    player.prevR = player.rotation || 0;
    
    // ===== ОБНОВЛЕНИЕ ПОЗИЦИИ С ОГРАНИЧЕНИЯМИ =====
    if (data.x !== undefined && data.z !== undefined) {
      // Ограничиваем картой
      let newX = Math.max(-30, Math.min(30, data.x));
      let newZ = Math.max(-30, Math.min(30, data.z));
      
      // Проверяем скорость (анти-чит)
      const dx = newX - player.x;
      const dz = newZ - player.z;
      const distance = Math.sqrt(dx * dx + dz * dz);
      const maxDelta = this.config.maxSpeed * deltaTime;
      
      if (distance > maxDelta) {
        // Ограничиваем слишком быстрое движение
        const ratio = maxDelta / distance;
        newX = player.x + dx * ratio;
        newZ = player.z + dz * ratio;
      }
      
      // ===== ПЛАВНАЯ ИНТЕРПОЛЯЦИЯ =====
      const smoothness = 0.3; // Меньше = плавнее
      player.x += (newX - player.x) * (1 - smoothness);
      player.z += (newZ - player.z) * (1 - smoothness);
    }
    
    // Обновляем поворот
    if (data.rotation !== undefined) {
      player.rotation = data.rotation;
    }
    
    if (data.pitch !== undefined) {
      player.pitch = Math.max(-Math.PI/2, Math.min(Math.PI/2, data.pitch));
    }
    
    player.lastUpdate = now;
    
    // Добавляем в буфер для отправки
    this.addToBuffer('move', player.id, {
      x: player.x,
      z: player.z,
      rotation: player.rotation,
      pitch: player.pitch,
      prevX: player.prevX,
      prevZ: player.prevZ,
      prevR: player.prevR,
      timestamp: now
    });
  }

  handlePing(ws, player, now) {
    ws.send(JSON.stringify({
      type: 'pong',
      timestamp: now,
      serverTime: now
    }));
  }

  handleShoot(player, data, now) {
    // Простая стрельба
    const rayX = player.x + Math.sin(player.rotation || 0) * 3;
    const rayZ = player.z + Math.cos(player.rotation || 0) * 3;
    
    let hit = false;
    let hitId = null;
    
    for (const [id, target] of this.players) {
      if (id === player.id) continue;
      
      const dx = target.x - rayX;
      const dz = target.z - rayZ;
      const dist = Math.sqrt(dx*dx + dz*dz);
      
      if (dist < 1.5) {
        target.health = Math.max(0, target.health - 10);
        hit = true;
        hitId = id;
        break;
      }
    }
    
    this.broadcastMessage({
      type: 'shoot_result',
      playerId: player.id,
      hit: hit,
      target: hitId,
      timestamp: now
    });
  }

  // ===== БУФЕР ОБНОВЛЕНИЙ =====
  addToBuffer(type, id, data) {
    this.updateBuffer.push({
      type,
      id,
      data,
      timestamp: Date.now()
    });
    
    // Ограничиваем размер буфера
    if (this.updateBuffer.length > 100) {
      this.updateBuffer = this.updateBuffer.slice(-50);
    }
  }

  processUpdates() {
    if (this.updateBuffer.length === 0) return;
    
    // Берем последние обновления
    const updates = this.updateBuffer.splice(0, Math.min(this.updateBuffer.length, 30));
    
    // Группируем по типу
    const moves = {};
    
    for (const update of updates) {
      if (update.type === 'move') {
        moves[update.id] = {
          ...(moves[update.id] || {}),
          ...update.data
        };
      }
    }
    
    // Отправляем сгруппированные обновления
    if (Object.keys(moves).length > 0) {
      this.sendDelta(moves);
    }
  }

  // ===== ОТПРАВКА СОСТОЯНИЙ =====
  sendState() {
    if (this.players.size === 0) return;
    
    const state = {
      type: 'state',
      players: this.serializePlayers(),
      objects: this.objects,
      tps: this.currentTPS,
      timestamp: Date.now(),
      serverTime: Date.now()
    };
    
    this.broadcastMessage(state);
  }

  sendDelta(moves) {
    const delta = {
      type: 'delta',
      moves: moves,
      timestamp: Date.now(),
      serverTime: Date.now()
    };
    
    this.broadcastMessage(delta);
  }

  serializePlayers() {
    const result = {};
    for (const [id, player] of this.players) {
      result[id] = {
        x: Math.round(player.x * 1000) / 1000,
        z: Math.round(player.z * 1000) / 1000,
        y: player.y,
        rotation: player.rotation,
        pitch: player.pitch,
        health: player.health,
        lastUpdate: player.lastUpdate,
        // Для интерполяции на клиенте
        prevX: player.prevX,
        prevZ: player.prevZ,
        prevR: player.prevR
      };
    }
    return result;
  }

  // ===== BROADCAST =====
  broadcastMessage(message) {
    const data = typeof message === 'string' ? message : JSON.stringify(message);
    const sockets = this.ctx.getWebSockets();
    
    for (const ws of sockets) {
      try {
        ws.send(data);
      } catch (error) {
        // Игнорируем
      }
    }
  }

  broadcastToOthers(exclude, message) {
    const data = typeof message === 'string' ? message : JSON.stringify(message);
    const sockets = this.ctx.getWebSockets();
    
    for (const ws of sockets) {
      if (ws === exclude) continue;
      try {
        ws.send(data);
      } catch (error) {
        // Игнорируем
      }
    }
  }

  // ===== ОЧИСТКА =====
  cleanupPlayers() {
    const now = Date.now();
    const timeout = 30000;
    const toRemove = [];
    
    for (const [id, player] of this.players) {
      if (now - player.lastActivity > timeout) {
        toRemove.push(id);
      }
    }
    
    for (const id of toRemove) {
      this.players.delete(id);
      // Удаляем ws
      for (const [ws, wsId] of this.wsMap) {
        if (wsId === id) {
          this.wsMap.delete(ws);
          try { ws.close(1000, 'Timeout'); } catch(e) {}
          break;
        }
      }
    }
    
    if (toRemove.length > 0) {
      console.log(`[Cleanup] Removed ${toRemove.length} players`);
      this.saveState();
    }
  }

  // ===== ХЕНДЛЕРЫ =====
  async handleStats() {
    return new Response(JSON.stringify({
      players: this.players.size,
      maxPlayers: this.config.maxPlayers,
      objects: this.objects.length,
      tps: this.currentTPS,
      connections: this.ctx.getWebSockets().length,
      bufferSize: this.updateBuffer.length
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  async handleReset() {
    this.players.clear();
    this.wsMap.clear();
    this.updateBuffer = [];
    
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(1000, 'Reset'); } catch(e) {}
    }
    
    await this.saveState();
    
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  webSocketClose(ws) {
    const playerId = this.wsMap.get(ws);
    if (playerId) {
      this.players.delete(playerId);
      this.wsMap.delete(ws);
      console.log(`[WS] Player ${playerId} disconnected`);
      
      this.broadcastMessage({
        type: 'player_left',
        id: playerId
      });
    }
  }

  webSocketError(ws, error) {
    console.error('[WS] Error:', error);
    this.webSocketClose(ws);
  }
}

// ===== WORKER =====
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    try {
      // Корневой путь - HTML
      if (url.pathname === '/') {
        return new Response(getHTML(), {
          headers: { 'Content-Type': 'text/html' }
        });
      }
      
      // Клиентский JS
      if (url.pathname === '/client.js') {
        return new Response(getClientJS(), {
          headers: { 'Content-Type': 'application/javascript' }
        });
      }
      
      // WebSocket - передаем в Durable Object
      if (url.pathname === '/ws') {
        const id = env.GAME_ROOM.idFromName('main');
        const room = env.GAME_ROOM.get(id);
        return room.fetch(request);
      }
      
      // API
      if (url.pathname.startsWith('/api/')) {
        const id = env.GAME_ROOM.idFromName('main');
        const room = env.GAME_ROOM.get(id);
        return room.fetch(request);
      }
      
      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('[Worker] Error:', error);
      return new Response('Error', { status: 500 });
    }
  }
};

// ===== HTML =====
function getHTML() {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Multiplayer Game</title>
  <style>
    * { margin: 0; padding: 0; }
    body { 
      background: #0a0a1a; 
      display: flex; 
      justify-content: center; 
      align-items: center; 
      height: 100vh;
      font-family: Arial;
    }
    #container { position: relative; }
    canvas {
      background: #1a1a2e;
      border: 2px solid #2a2a4e;
      border-radius: 8px;
    }
    #ui {
      position: absolute;
      top: 10px;
      left: 10px;
      color: #fff;
      font-size: 12px;
      background: rgba(0,0,0,0.7);
      padding: 8px 12px;
      border-radius: 4px;
      pointer-events: none;
    }
    #controls {
      position: absolute;
      bottom: 10px;
      left: 50%;
      transform: translateX(-50%);
      color: #666;
      font-size: 12px;
      background: rgba(0,0,0,0.7);
      padding: 4px 12px;
      border-radius: 4px;
      pointer-events: none;
    }
  </style>
</head>
<body>
  <div id="container">
    <canvas id="game" width="800" height="600"></canvas>
    <div id="ui">Connecting...</div>
    <div id="controls">WASD - Move | Click - Shoot</div>
  </div>
  <script src="/client.js"></script>
</body>
</html>`;
}

// ===== КЛИЕНТСКИЙ JS =====
function getClientJS() {
  return `
// ===== КЛИЕНТ =====
class GameClient {
  constructor() {
    this.players = new Map();
    this.localId = null;
    this.localPlayer = null;
    this.keys = {};
    this.ws = null;
    this.canvas = document.getElementById('game');
    this.ctx = this.canvas.getContext('2d');
    this.ui = document.getElementById('ui');
    this.interpolationDelay = 50;
    
    this.setupInput();
    this.connect();
    this.loop();
  }
  
  connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(\`\${protocol}//\${window.location.host}/ws\`);
    
    this.ws.onopen = () => {
      this.ui.textContent = 'Connected!';
      console.log('Connected');
    };
    
    this.ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        this.handleMessage(data);
      } catch(err) {
        console.error('Parse error:', err);
      }
    };
    
    this.ws.onclose = () => {
      this.ui.textContent = 'Disconnected! Reconnecting...';
      console.log('Disconnected, reconnecting...');
      setTimeout(() => this.connect(), 3000);
    };
    
    this.ws.onerror = (err) => {
      console.error('WS error:', err);
    };
  }
  
  handleMessage(data) {
    switch(data.type) {
      case 'init':
        this.handleInit(data);
        break;
      case 'state':
        this.handleState(data);
        break;
      case 'delta':
        this.handleDelta(data);
        break;
      case 'player_joined':
        this.handlePlayerJoined(data);
        break;
      case 'player_left':
        this.players.delete(data.id);
        break;
      case 'shoot_result':
        if (data.hit) console.log('Hit!');
        break;
      case 'pong':
        this.handlePong(data);
        break;
    }
  }
  
  handleInit(data) {
    this.localId = data.playerId;
    this.interpolationDelay = data.config?.interpolationDelay || 50;
    
    // Создаем игроков
    for (const [id, p] of Object.entries(data.players)) {
      this.players.set(id, {
        ...p,
        renderX: p.x,
        renderZ: p.z,
        renderR: p.rotation,
        prevX: p.x,
        prevZ: p.z,
        prevR: p.rotation,
        lastUpdate: Date.now()
      });
      if (id === this.localId) {
        this.localPlayer = this.players.get(id);
      }
    }
    
    this.ui.textContent = \`Players: \${this.players.size}\`;
    console.log('Init complete');
  }
  
  handleState(data) {
    const now = Date.now();
    
    for (const [id, p] of Object.entries(data.players)) {
      let player = this.players.get(id);
      
      if (!player) {
        player = {
          ...p,
          renderX: p.x,
          renderZ: p.z,
          renderR: p.rotation,
          prevX: p.x,
          prevZ: p.z,
          prevR: p.rotation,
          lastUpdate: now
        };
        this.players.set(id, player);
      } else {
        // Сохраняем для интерполяции
        player.prevX = player.x;
        player.prevZ = player.z;
        player.prevR = player.rotation;
        player.lastUpdate = now;
        
        // Обновляем
        player.x = p.x;
        player.z = p.z;
        player.rotation = p.rotation;
        player.pitch = p.pitch;
        player.health = p.health;
      }
      
      if (id === this.localId) {
        this.localPlayer = player;
      }
    }
    
    // Удаляем отсутствующих
    for (const id of this.players.keys()) {
      if (!data.players[id]) {
        this.players.delete(id);
      }
    }
    
    this.ui.textContent = \`Players: \${this.players.size} | TPS: \${data.tps || 0}\`;
  }
  
  handleDelta(data) {
    const now = Date.now();
    
    for (const [id, move] of Object.entries(data.moves)) {
      const player = this.players.get(id);
      if (!player) continue;
      
      player.prevX = player.x;
      player.prevZ = player.z;
      player.prevR = player.rotation;
      player.lastUpdate = now;
      
      player.x = move.x;
      player.z = move.z;
      player.rotation = move.rotation;
      player.pitch = move.pitch;
    }
  }
  
  handlePlayerJoined(data) {
    const player = {
      x: data.player.x,
      z: data.player.z,
      rotation: data.player.rotation,
      health: data.player.health,
      renderX: data.player.x,
      renderZ: data.player.z,
      renderR: data.player.rotation,
      prevX: data.player.x,
      prevZ: data.player.z,
      prevR: data.player.rotation,
      lastUpdate: Date.now()
    };
    this.players.set(data.id, player);
  }
  
  handlePong(data) {
    const ping = Date.now() - data.timestamp;
    this.ui.textContent = \`Ping: \${ping}ms | Players: \${this.players.size}\`;
  }
  
  setupInput() {
    document.addEventListener('keydown', (e) => {
      this.keys[e.key.toLowerCase()] = true;
    });
    document.addEventListener('keyup', (e) => {
      this.keys[e.key.toLowerCase()] = false;
    });
    this.canvas.addEventListener('click', () => this.shoot());
  }
  
  shoot() {
    if (this.ws?.readyState === WebSocket.OPEN && this.localPlayer) {
      this.ws.send(JSON.stringify({
        type: 'shoot',
        rotation: this.localPlayer.rotation || 0
      }));
    }
  }
  
  loop() {
    const now = Date.now();
    this.updateLocal();
    this.interpolate(now);
    this.render();
    requestAnimationFrame(() => this.loop());
  }
  
  updateLocal() {
    if (!this.localPlayer || !this.ws) return;
    
    const speed = 5;
    let dx = 0, dz = 0;
    
    if (this.keys['w']) dz -= speed;
    if (this.keys['s']) dz += speed;
    if (this.keys['a']) dx -= speed;
    if (this.keys['d']) dx += speed;
    
    if (dx !== 0 || dz !== 0) {
      const len = Math.sqrt(dx*dx + dz*dz);
      if (len > speed) {
        dx = dx / len * speed;
        dz = dz / len * speed;
      }
      
      const dt = 0.016;
      this.localPlayer.x += dx * dt;
      this.localPlayer.z += dz * dt;
      
      this.localPlayer.x = Math.max(-30, Math.min(30, this.localPlayer.x));
      this.localPlayer.z = Math.max(-30, Math.min(30, this.localPlayer.z));
      
      // Отправка движения
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'move',
          x: this.localPlayer.x,
          z: this.localPlayer.z,
          rotation: this.localPlayer.rotation || 0,
          pitch: this.localPlayer.pitch || 0
        }));
      }
    }
  }
  
  interpolate(now) {
    const renderTime = now - this.interpolationDelay;
    
    for (const [id, player] of this.players) {
      if (!player.prevX) continue;
      
      const timeDiff = renderTime - player.lastUpdate;
      const factor = Math.max(0, Math.min(1, timeDiff / 50));
      
      // Плавная интерполяция
      player.renderX = player.prevX + (player.x - player.prevX) * factor;
      player.renderZ = player.prevZ + (player.z - player.prevZ) * factor;
      player.renderR = player.prevR + (player.rotation - player.prevR) * factor;
    }
  }
  
  render() {
    const ctx = this.ctx;
    const c = this.canvas;
    const local = this.localPlayer;
    
    ctx.clearRect(0, 0, c.width, c.height);
    
    // Сетка
    ctx.strokeStyle = '#2a2a4e';
    ctx.lineWidth = 0.5;
    for (let i = -30; i <= 30; i += 5) {
      const x = c.width/2 + (i - (local?.x || 0)) * 20;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, c.height);
      ctx.stroke();
      
      const y = c.height/2 + (i - (local?.z || 0)) * 20;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(c.width, y);
      ctx.stroke();
    }
    
    // Игроки
    for (const [id, player] of this.players) {
      const x = c.width/2 + (player.renderX - (local?.x || 0)) * 20;
      const y = c.height/2 + (player.renderZ - (local?.z || 0)) * 20;
      
      // Тело
      ctx.beginPath();
      ctx.arc(x, y, 10, 0, Math.PI * 2);
      
      if (id === this.localId) {
        ctx.fillStyle = '#00ff88';
        ctx.strokeStyle = '#00ffcc';
      } else {
        ctx.fillStyle = '#ff4444';
        ctx.strokeStyle = '#ff6666';
      }
      ctx.fill();
      ctx.stroke();
      
      // Направление
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(
        x + Math.sin(player.renderR || 0) * 25,
        y + Math.cos(player.renderR || 0) * 25
      );
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
      
      // Имя
      ctx.fillStyle = '#fff';
      ctx.font = '10px Arial';
      ctx.textAlign = 'center';
      ctx.fillText(id.slice(0, 6), x, y - 20);
      
      // HP
      ctx.fillStyle = player.health > 50 ? '#0f0' : '#f00';
      ctx.fillRect(x - 15, y - 30, 30 * (player.health / 100), 3);
    }
  }
}

// Запуск
new GameClient();`;
      }
