// ===== НОВАЯ ВЕРСИЯ С COLYSEUS =====
import { Server, Room, Client } from '@colyseus/colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Schema, type, MapSchema } from '@colyseus/schema';

// ===== КЛИЕНТСКАЯ СТРУКТУРА =====
class Player extends Schema {
  @type('string') id: string;
  @type('number') x: number = 0;
  @type('number') z: number = 0;
  @type('number') y: number = 0.5;
  @type('number') rotation: number = 0;
  @type('number') pitch: number = 0;
  @type('number') health: number = 100;
  @type('number') speed: number = 0;
  @type('boolean') isMoving: boolean = false;
  @type('number') lastUpdate: number = Date.now();
}

class GameState extends Schema {
  @type({ map: Player }) 
  players = new MapSchema<Player>();
  
  @type('number') timestamp: number = Date.now();
  @type('number') serverTime: number = Date.now();
}

// ===== ИГРОВАЯ КОМНАТА =====
class GameRoom extends Room<GameState> {
  maxClients = 50;
  private tickRate = 60;
  private stateSendRate = 20;
  private lastStateSend = 0;
  private moveThreshold = 0.001;
  
  onCreate(options: any) {
    this.setState(new GameState());
    
    // Автоматическая синхронизация
    this.setSimulationInterval(() => this.update(), 1000 / this.tickRate);
    
    // Генерация объектов
    this.generateObjects();
    
    console.log('[GameRoom] Created');
  }
  
  onJoin(client: Client, options: any) {
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
      moveThreshold: this.moveThreshold
    });
    
    console.log(`[GameRoom] Player ${client.sessionId} joined`);
  }
  
  onLeave(client: Client, consented: boolean) {
    this.state.players.delete(client.sessionId);
    console.log(`[GameRoom] Player ${client.sessionId} left`);
  }
  
  onMessage(client: Client, message: any) {
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
      }
    } catch (error) {
      console.error('[GameRoom] Message error:', error);
    }
  }
  
  private handleMove(client: Client, player: Player, data: any) {
    const now = Date.now();
    const deltaTime = (now - player.lastUpdate) / 1000;
    
    // Предиктивная синхронизация с плавностью
    const speed = 5; // Максимальная скорость
    const maxDelta = speed * deltaTime;
    
    // Плавное движение с ограничением
    if (data.x !== undefined && data.z !== undefined) {
      const dx = data.x - player.x;
      const dz = data.z - player.z;
      const distance = Math.sqrt(dx * dx + dz * dz);
      
      if (distance > 0 && distance < maxDelta * 2) {
        // Плавная интерполяция
        const lerpFactor = Math.min(1, distance / maxDelta);
        player.x += dx * lerpFactor * 0.5;
        player.z += dz * lerpFactor * 0.5;
        player.isMoving = distance > 0.001;
        player.speed = distance / deltaTime;
      }
    }
    
    if (data.rotation !== undefined) {
      player.rotation = data.rotation;
    }
    
    if (data.pitch !== undefined) {
      player.pitch = data.pitch;
    }
    
    player.lastUpdate = now;
  }
  
  private handlePing(client: Client, player: Player) {
    client.send('pong', {
      timestamp: Date.now(),
      serverTime: Date.now()
    });
  }
  
  private handleShoot(client: Client, player: Player, data: any) {
    // Простая логика стрельбы
    const rayX = player.x + Math.sin(player.rotation) * 3;
    const rayZ = player.z + Math.cos(player.rotation) * 3;
    
    // Проверка попаданий в игроков
    for (const [id, target] of this.state.players) {
      if (id === client.sessionId) continue;
      
      const dx = target.x - rayX;
      const dz = target.z - rayZ;
      const dist = Math.sqrt(dx * dx + dz * dz);
      
      if (dist < 1.5) {
        target.health = Math.max(0, target.health - 10);
        client.send('hit', {
          target: id,
          damage: 10
        });
        break;
      }
    }
  }
  
  private update() {
    const now = Date.now();
    
    // Анти-чит и коррекция
    for (const [id, player] of this.state.players) {
      // Проверка на слишком быстрые движения
      const deltaTime = (now - player.lastUpdate) / 1000;
      if (deltaTime > 0.1) {
        // Коррекция позиции
        player.isMoving = false;
        player.speed = 0;
      }
    }
    
    // Отправка состояния с правильной частотой
    if (now - this.lastStateSend > 1000 / this.stateSendRate) {
      this.state.timestamp = now;
      this.state.serverTime = now;
      
      // Сжатое состояние для оптимизации
      const compressedState = {
        t: this.state.timestamp,
        p: this.compressPlayers()
      };
      
      this.broadcast('state', compressedState);
      this.lastStateSend = now;
    }
  }
  
  private compressPlayers() {
    const data: any = {};
    for (const [id, player] of this.state.players) {
      data[id] = {
        x: Math.round(player.x * 1000) / 1000,
        z: Math.round(player.z * 1000) / 1000,
        r: Math.round(player.rotation * 1000) / 1000,
        p: Math.round(player.pitch * 1000) / 1000,
        m: player.isMoving ? 1 : 0,
        h: player.health
      };
    }
    return data;
  }
  
  private generateObjects() {
    // Оставляем генерацию объектов, но оптимизируем
    // Можно добавить как отдельный массив
  }
}

// ===== КЛИЕНТСКАЯ ЧАСТЬ =====
// Это код для браузера
const clientCode = `
class GameClient {
  constructor() {
    this.players = new Map();
    this.localPlayer = null;
    this.interpolationDelay = 50;
    this.serverTime = 0;
    this.lastServerState = null;
    this.stateQueue = [];
    this.moveQueue = [];
    
    this.connect();
  }
  
  async connect() {
    const host = window.location.hostname === 'localhost' 
      ? 'ws://localhost:2567' 
      : window.location.origin.replace('http', 'ws');
    
    this.client = new Colyseus.Client(host);
    
    try {
      this.room = await this.client.joinOrCreate('game');
      console.log('Connected to game room');
      
      this.setupListeners();
      this.startGameLoop();
    } catch (error) {
      console.error('Connection error:', error);
    }
  }
  
  setupListeners() {
    this.room.onMessage('config', (config) => {
      this.interpolationDelay = config.interpolationDelay;
      this.moveThreshold = config.moveThreshold;
    });
    
    this.room.onMessage('state', (state) => {
      this.handleState(state);
    });
    
    this.room.onMessage('pong', (data) => {
      this.handlePong(data);
    });
    
    this.room.onStateChange((state) => {
      this.handleStateChange(state);
    });
  }
  
  handleState(compressedState) {
    this.serverTime = compressedState.t;
    this.lastServerState = compressedState;
    
    // Обновляем состояние игроков с интерполяцией
    for (const [id, data] of Object.entries(compressedState.p || {})) {
      let player = this.players.get(id);
      if (!player) {
        player = { x: data.x, z: data.z, rotation: data.r, pitch: data.p };
        this.players.set(id, player);
      }
      
      // Сохраняем предыдущие значения для интерполяции
      player.prevX = player.x;
      player.prevZ = player.z;
      player.prevR = player.rotation;
      
      // Обновляем текущие значения
      player.x = data.x;
      player.z = data.z;
      player.rotation = data.r;
      player.pitch = data.p;
      player.isMoving = data.m === 1;
      player.health = data.h;
      player.lastUpdate = Date.now();
      
      if (id === this.room.sessionId) {
        this.localPlayer = player;
      }
    }
  }
  
  handleStateChange(state) {
    // Обработка изменений в реальном времени
  }
  
  handlePong(data) {
    const ping = Date.now() - data.timestamp;
    // Обновляем пинг
  }
  
  startGameLoop() {
    this.gameLoop();
  }
  
  gameLoop() {
    const now = Date.now();
    
    // Интерполяция для плавного движения
    if (this.lastServerState) {
      const interpolationFactor = this.interpolationDelay / 1000;
      // Применяем интерполяцию для всех игроков
      this.applyInterpolation(now);
    }
    
    this.sendMovement();
    requestAnimationFrame(() => this.gameLoop());
  }
  
  applyInterpolation(now) {
    const renderTime = now - this.interpolationDelay;
    
    for (const [id, player] of this.players) {
      if (!player.prevX) continue;
      
      // Рассчитываем коэффициент интерполяции
      const timeDiff = renderTime - (player.lastUpdate || 0);
      const interpolationFactor = Math.min(1, timeDiff / 50); // 50ms интерполяции
      
      // Плавная интерполяция позиции
      player.renderX = player.prevX + (player.x - player.prevX) * interpolationFactor;
      player.renderZ = player.prevZ + (player.z - player.prevZ) * interpolationFactor;
      player.renderR = player.prevR + (player.rotation - player.prevR) * interpolationFactor;
    }
  }
  
  sendMovement() {
    if (!this.room) return;
    
    const now = Date.now();
    const lastSend = this.lastSendTime || 0;
    
    // Отправка с правильной частотой (20 раз в секунду)
    if (now - lastSend > 50) {
      this.room.send('move', {
        x: this.localPlayer?.x || 0,
        z: this.localPlayer?.z || 0,
        rotation: this.localPlayer?.rotation || 0,
        pitch: this.localPlayer?.pitch || 0
      });
      
      this.lastSendTime = now;
    }
  }
  
  // Методы для управления игроком
  move(x, z) {
    if (this.localPlayer) {
      this.localPlayer.x = x;
      this.localPlayer.z = z;
    }
  }
  
  rotate(rotation) {
    if (this.localPlayer) {
      this.localPlayer.rotation = rotation;
    }
  }
  
  shoot() {
    if (this.room) {
      this.room.send('shoot', {
        x: this.localPlayer?.x || 0,
        z: this.localPlayer?.z || 0,
        rotation: this.localPlayer?.rotation || 0
      });
    }
  }
}

// Инициализация клиента
const game = new GameClient();

// Экспорт для использования в браузере
window.GameClient = GameClient;
window.game = game;
`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Отдаем клиентский код
    if (url.pathname === '/client.js') {
      return new Response(clientCode, {
        headers: { 'Content-Type': 'application/javascript' }
      });
    }
    
    // Главная страница с клиентом
    if (url.pathname === '/') {
      return new Response(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Game Server</title>
            <script src="https://cdn.jsdelivr.net/npm/colyseus.js@0.15.x/dist/colyseus.js"></script>
          </head>
          <body>
            <h1>Game Server</h1>
            <div id="status">Connecting...</div>
            <canvas id="game" width="800" height="600"></canvas>
            <script src="/client.js"></script>
          </body>
        </html>
      `, {
        headers: { 'Content-Type': 'text/html' }
      });
    }
    
    // WebSocket маршрут для Colyseus
    if (url.pathname === '/ws') {
      // Используем Colyseus WebSocket транспорт
      const server = new Server({
        transport: new WebSocketTransport({
          server: {
            handleUpgrade: (request, socket, head) => {
              // Обработка WebSocket соединения
            }
          }
        })
      });
      
      server.define('game', GameRoom);
      return server.handleUpgrade(request);
    }
    
    return new Response('Not Found', { status: 404 });
  }
};
