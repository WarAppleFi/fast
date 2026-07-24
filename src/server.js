// src/server.js
import { DurableObject } from 'cloudflare:workers';

// ============================================
// GAME ROOM - DURABLE OBJECT
// ============================================
export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.players = new Map();
    this.worldWidth = 800;
    this.worldHeight = 600;
    this.lastUpdate = Date.now();
    this.updateCounter = 0;
    
    // Инициализация при создании
    this.ctx.blockConcurrencyWhile(async () => {
      await this.initialize();
    });
  }

  async initialize() {
    try {
      const stored = await this.ctx.storage.get('state');
      if (stored) {
        this.players = new Map(Object.entries(stored.players || {}));
        this.worldWidth = stored.worldWidth || 800;
        this.worldHeight = stored.worldHeight || 600;
        console.log(`[GameRoom] Loaded ${this.players.size} players`);
      }
    } catch (e) {
      console.error('[GameRoom] Load error:', e);
    }
  }

  async saveState() {
    try {
      const data = {
        players: Object.fromEntries(this.players),
        worldWidth: this.worldWidth,
        worldHeight: this.worldHeight
      };
      await this.ctx.storage.put('state', data);
    } catch (e) {
      console.error('[GameRoom] Save error:', e);
    }
  }

  // ============ HTTP METHODS ============
  
  async getState() {
    const state = {
      type: 'state',
      timestamp: Date.now(),
      players: {}
    };

    for (const [id, player] of this.players) {
      state.players[id] = {
        x: player.x,
        y: player.y,
        health: player.health,
        angle: player.angle || 0,
        size: player.size || 30
      };
    }

    return state;
  }

  async addPlayer(playerId) {
    if (this.players.has(playerId)) {
      return this.players.get(playerId);
    }

    const player = {
      id: playerId,
      x: 100 + Math.random() * (this.worldWidth - 200),
      y: 100 + Math.random() * (this.worldHeight - 200),
      health: 100,
      angle: 0,
      size: 30,
      lastActive: Date.now()
    };

    this.players.set(playerId, player);
    await this.saveState();
    console.log(`[GameRoom] Player joined: ${playerId} (${this.players.size} total)`);
    
    return player;
  }

  async updatePlayer(playerId, data) {
    const player = this.players.get(playerId);
    if (!player) return null;

    if (data.x !== undefined) {
      player.x = Math.max(20, Math.min(this.worldWidth - 20, data.x));
    }
    if (data.y !== undefined) {
      player.y = Math.max(20, Math.min(this.worldHeight - 20, data.y));
    }
    if (data.angle !== undefined) {
      player.angle = data.angle;
    }
    if (data.health !== undefined) {
      player.health = Math.max(0, Math.min(100, data.health));
    }
    
    player.lastActive = Date.now();
    this.updateCounter++;

    if (this.updateCounter % 10 === 0) {
      await this.saveState();
    }

    return player;
  }

  async removePlayer(playerId) {
    if (this.players.has(playerId)) {
      this.players.delete(playerId);
      await this.saveState();
      console.log(`[GameRoom] Player left: ${playerId} (${this.players.size} total)`);
      return true;
    }
    return false;
  }

  async cleanupInactive() {
    const now = Date.now();
    const timeout = 30000;
    let removed = 0;

    for (const [id, player] of this.players) {
      if (now - player.lastActive > timeout) {
        this.players.delete(id);
        removed++;
      }
    }

    if (removed > 0) {
      await this.saveState();
      console.log(`[GameRoom] Cleaned up ${removed} inactive players`);
    }
  }

  async getPlayerCount() {
    return this.players.size;
  }
}

// ============================================
// WORKER
// ============================================
export default {
  async fetch(request, env) {
    // ===== CORS PREFLIGHT =====
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        }
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const gameId = url.searchParams.get('id') || 'main';
    
    try {
      // Получаем Durable Object
      const id = env.GAME.idFromName(gameId);
      const gameRoom = env.GAME.get(id);

      // ============ GET STATE ============
      if (path === '/state') {
        const state = await gameRoom.getState();
        return new Response(JSON.stringify(state), {
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

      // ============ JOIN ============
      if (path === '/join') {
        const playerId = url.searchParams.get('playerId') || crypto.randomUUID().slice(0, 8);
        const player = await gameRoom.addPlayer(playerId);
        const state = await gameRoom.getState();
        
        return new Response(JSON.stringify({
          success: true,
          playerId: playerId,
          player: player,
          state: state
        }), {
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

      // ============ MOVE ============
      if (path === '/move') {
        const playerId = url.searchParams.get('playerId');
        if (!playerId) {
          return new Response(JSON.stringify({ error: 'Missing playerId' }), {
            status: 400,
            headers: { 
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }

        const data = await request.json();
        const player = await gameRoom.updatePlayer(playerId, data);
        
        if (!player) {
          return new Response(JSON.stringify({ error: 'Player not found' }), {
            status: 404,
            headers: { 
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }

        return new Response(JSON.stringify({
          success: true,
          player: player
        }), {
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

      // ============ LEAVE ============
      if (path === '/leave') {
        const playerId = url.searchParams.get('playerId');
        if (playerId) {
          await gameRoom.removePlayer(playerId);
        }
        return new Response(JSON.stringify({ success: true }), {
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

      // ============ CLEANUP ============
      if (path === '/cleanup') {
        await gameRoom.cleanupInactive();
        return new Response(JSON.stringify({ success: true }), {
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

      // ============ HEALTH ============
      if (path === '/health' || path === '/') {
        const count = await gameRoom.getPlayerCount();
        return new Response(JSON.stringify({
          status: 'OK',
          players: count,
          timestamp: Date.now()
        }), {
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

      // ============ 404 ============
      return new Response('Not found', { 
        status: 404,
        headers: { 'Access-Control-Allow-Origin': '*' }
      });

    } catch (e) {
      console.error('[Worker] Error:', e);
      return new Response(JSON.stringify({ 
        error: 'Internal server error',
        message: e.message 
      }), {
        status: 500,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
  }
};
