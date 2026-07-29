// server.js - точка входа для Cloudflare Worker
import wasm from './src/server.wasm';

// Кэшируем инициализированный экземпляр
let wasmInstance = null;

async function initWasm() {
  if (wasmInstance) {
    return wasmInstance;
  }

  try {
    const result = await WebAssembly.instantiate(wasm, {
      env: {}
    });
    wasmInstance = result.instance.exports;
    return wasmInstance;
  } catch (error) {
    console.error('Ошибка инициализации WASM:', error);
    throw error;
  }
}

// Экспортируем Durable Object GameRoom из WASM
export const GameRoom = {
  async fetch(request, env, ctx) {
    const wasm = await initWasm();
    return wasm.GameRoom.fetch(request, env, ctx);
  },
  
  // Если у GameRoom есть другие методы, их тоже нужно экспортировать
  // Например, если есть метод new() или другие статические методы
};

// Экспортируем основной обработчик fetch
export default {
  async fetch(request, env, ctx) {
    try {
      const wasm = await initWasm();
      return wasm.main(request, env, ctx);
    } catch (error) {
      console.error('Ошибка выполнения Worker:', error);
      return new Response(`Ошибка: ${error.message}`, { 
        status: 500,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
  }
};
