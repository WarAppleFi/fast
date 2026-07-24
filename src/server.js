// server.js - Полностью рабочий сервер для локального запуска с WebSocket

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ 
  server,
  path: '/ws',
  clientTracking: true
});

// ===== ИГРОВОЕ СОСТОЯНИЕ =====
const gameState = {
  players: new Map(),     // playerId -> playerData
  playerNames: new Map(), // playerId -> name
  sessions: new Map(),    // ws -> playerId
  objects: [],
  tickCount: 0,
  tps: 0,
  lastTpsUpdate: Date.now(),
  tickInterval: null
};

// ===== ГЕНЕРАЦИЯ ИМЕНИ =====
const adjectives = ['Быстрый', 'Смелый', 'Храбрый', 'Мудрый', 'Ловкий', 'Сильный', 'Тихий', 'Громкий', 'Яркий', 'Тёмный'];
const nouns = ['Волк', 'Лис', 'Медведь', 'Орёл', 'Тигр', 'Дракон', 'Сокол', 'Кот', 'Пёс', 'Лев'];

function generateName() {
  return `${adjectives[Math.floor(Math.random() * adjectives.length)]}${nouns[Math.floor(Math.random() * nouns.length)]}`;
}

// ===== ИНИЦИАЛИЗАЦИЯ =====
function initializeGame() {
  if (gameState.tickInterval) return;
  
  gameState.tickInterval = setInterval(() => gameTick(), 50);
  
  setInterval(() => {
    const now = Date.now();
    const delta = (now - gameState.lastTpsUpdate) / 1000;
    if (delta > 0) {
      gameState.tps = Math.round(gameState.tickCount / delta);
      gameState.tickCount = 0;
      gameState.lastTpsUpdate = now;
    }
  }, 1000);
  
  console.log('Game initialized');
}

// ===== ИГРОВОЙ ТИК =====
function gameTick() {
  gameState.tickCount++;
  
  // Восстановление здоровья
  for (const [id, player] of gameState.players) {
    if (player.health < 100) {
      player.health = Math.min(100, player.health + 0.5);
    }
  }
  
  broadcastDelta();
}

// ===== ПОЛУЧЕНИЕ ПОЗИЦИИ СПАВНА =====
function getRandomSpawn() {
  const angle = Math.random() * Math.PI * 2;
  const radius = 3 + Math.random() * 5;
  return {
    x: Math.cos(angle) * radius,
    z: Math.sin(angle) * radius
  };
}

// ===== ОБРАБОТКА ВЕБСОКЕТА =====
function handleWebSocket(ws) {
  try {
    const playerId = crypto.randomUUID();
    const name = generateName();
    gameState.playerNames.set(playerId, name);
    
    const spawnPos = getRandomSpawn();
    const player = {
      id: playerId,
      x: spawnPos.x,
      z: spawnPos.z,
      y: 0,
      rotation: 0,
      pitch: 0,
      health: 100,
      name: name
    };
    
    gameState.players.set(playerId, player);
    gameState.sessions.set(ws, playerId);
    
    console.log(`Player ${name} (${playerId}) connected`);
    
    // Отправка инициализации
    ws.send(JSON.stringify({
      type: 'init',
      playerId: playerId,
      players: getPlayersData(),
      objects: gameState.objects,
      tps: gameState.tps
    }));
    
    ws.on('message', (rawData) => {
      try {
        const data = JSON.parse(rawData.toString());
        handleMessage(ws, data);
      } catch (e) {
        console.error('Message parse error:', e);
      }
    });
    
    ws.on('close', () => {
      const name = gameState.playerNames.get(playerId) || 'Unknown';
      console.log(`Player ${name} (${playerId}) disconnected`);
      gameState.players.delete(playerId);
      gameState.sessions.delete(ws);
      gameState.playerNames.delete(playerId);
      broadcastDelta();
    });
    
    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
    
  } catch (e) {
    console.error('WebSocket handler error:', e);
    ws.close();
  }
}

// ===== ОБРАБОТКА СООБЩЕНИЙ =====
function handleMessage(ws, data) {
  const playerId = gameState.sessions.get(ws);
  if (!playerId) return;
  
  const player = gameState.players.get(playerId);
  if (!player) return;
  
  switch(data.type) {
    case 'move':
      const dx = data.x - player.x;
      const dz = data.z - player.z;
      const dist = Math.hypot(dx, dz);
      
      if (dist < 0.5) {
        player.x = data.x;
        player.z = data.z;
        player.rotation = data.rotation || player.rotation;
        player.pitch = data.pitch || player.pitch;
      }
      break;
      
    case 'shoot':
      handleShoot(playerId, player);
      break;
      
    case 'chat':
      const name = gameState.playerNames.get(playerId) || 'Unknown';
      broadcastChat(name, data.text, playerId);
      break;
      
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;
  }
}

// ===== СТРЕЛЬБА =====
function handleShoot(playerId, player) {
  if (player.health <= 0) return;
  
  const origin = { x: player.x, z: player.z };
  const angle = player.rotation;
  const direction = { x: -Math.sin(angle), z: -Math.cos(angle) };
  
  let closestHit = null;
  let closestDist = Infinity;
  
  for (const [id, target] of gameState.players) {
    if (id === playerId) continue;
    if (target.health <= 0) continue;
    
    const dx = target.x - origin.x;
    const dz = target.z - origin.z;
    
    const proj = dx * direction.x + dz * direction.z;
    if (proj < 0 || proj > 15) continue;
    
    const perpX = dx - proj * direction.x;
    const perpZ = dz - proj * direction.z;
    const perpDist = Math.hypot(perpX, perpZ);
    
    if (perpDist < 0.8) {
      if (proj < closestDist) {
        closestDist = proj;
        closestHit = id;
      }
    }
  }
  
  if (closestHit) {
    const target = gameState.players.get(closestHit);
    if (target) {
      target.health = Math.max(0, target.health - 25);
      
      if (target.health <= 0) {
        const spawn = getRandomSpawn();
        target.x = spawn.x;
        target.z = spawn.z;
        target.health = 100;
      }
    }
  }
  
  broadcastDelta();
}

// ===== РАССЫЛКА =====
function broadcastDelta() {
  const data = {
    type: 'delta',
    players: getPlayersDelta(),
    objects: gameState.objects,
    tps: gameState.tps
  };
  
  const message = JSON.stringify(data);
  for (const [ws] of gameState.sessions) {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    } catch (e) {
      // Игнорируем
    }
  }
}

function broadcastChat(name, text, senderId) {
  const message = JSON.stringify({
    type: 'chat',
    name: name,
    text: text,
    id: senderId
  });
  
  for (const [ws] of gameState.sessions) {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    } catch (e) {
      // Игнорируем
    }
  }
}

function getPlayersData() {
  const result = {};
  for (const [id, player] of gameState.players) {
    result[id] = { ...player };
    delete result[id].id; // Убираем дублирование id
  }
  return result;
}

function getPlayersDelta() {
  const result = {};
  for (const [id, player] of gameState.players) {
    result[id] = {
      x: player.x,
      z: player.z,
      rotation: player.rotation,
      pitch: player.pitch,
      health: player.health
    };
  }
  return result;
}

// ===== HTTP РОУТЫ =====
app.get('/status', (req, res) => {
  res.json({
    status: 'ok',
    players: gameState.players.size,
    tps: gameState.tps,
    timestamp: Date.now()
  });
});

app.get('/players', (req, res) => {
  const players = [];
  for (const [id, player] of gameState.players) {
    players.push({
      id,
      name: gameState.playerNames.get(id) || 'Unknown',
      x: player.x,
      z: player.z,
      health: player.health
    });
  }
  res.json(players);
});

// ===== ЗАПУСК =====
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}/ws`);
  console.log(`📊 Status: http://localhost:${PORT}/status`);
  initializeGame();
});

// Обработка закрытия
process.on('SIGINT', () => {
  if (gameState.tickInterval) {
    clearInterval(gameState.tickInterval);
  }
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
