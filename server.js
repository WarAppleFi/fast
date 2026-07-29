// server.js - точка входа для Cloudflare Worker
import wasm from './src/server.wasm';

// Кэшируем инициализированный экземпляр
let wasmInstance = null;

async function initWasm() {
  if (wasmInstance) {
    return wasmInstance;
  }

  try {
    // Инициализируем WASM модуль
    const imports = {
      env: {
        // Здесь можно добавить функции окружения, если нужно
        // Например, для работы с Durable Objects
      }
    };

    const result = await WebAssembly.instantiate(wasm, imports);
    wasmInstance = result.instance.exports;
    return wasmInstance;
  } catch (error) {
    console.error('Ошибка инициализации WASM:', error);
    throw error;
  }
}

// Экспортируем обработчик запросов
export default {
  async fetch(request, env, ctx) {
    try {
      // Инициализируем WASM
      const wasm = await initWasm();
      
      // Вызываем функцию main из Rust кода
      // Передаём request, env и ctx как аргументы
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
