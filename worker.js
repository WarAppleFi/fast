import wasmModule from './core.wasm';

// Инициализация WASM модуля
let wasmInitialized = false;
let wasmExports = null;

async function initWasm() {
    if (!wasmInitialized) {
        const instance = await WebAssembly.instantiate(wasmModule, {
            // Здесь можно добавить импорты, если они нужны
        });
        wasmExports = instance.exports;
        wasmInitialized = true;
    }
    return wasmExports;
}

// Экспортируем обработчик fetch для Cloudflare Workers
export default {
    async fetch(request, env, ctx) {
        try {
            // Инициализируем WASM
            const exports = await initWasm();
            
            // Вызываем экспортированную функцию из Rust
            // Ваш Rust код экспортирует функцию __wbg_fetch или подобную
            // в зависимости от того, как вы его скомпилировали
            if (exports.__wbg_fetch) {
                // Передаем request, env, ctx в WASM
                const result = await exports.__wbg_fetch(request, env, ctx);
                return result;
            } else {
                // Альтернативный подход - передаем как строку
                const requestData = {
                    url: request.url,
                    method: request.method,
                    headers: Object.fromEntries(request.headers),
                    body: request.body ? await request.text() : null
                };
                
                // Вызываем вашу Rust функцию
                const response = await exports.handle_request(JSON.stringify(requestData));
                return new Response(response.body, {
                    status: response.status || 200,
                    headers: response.headers || {}
                });
            }
        } catch (error) {
            console.error('WASM error:', error);
            return new Response(`Error: ${error.message}`, { status: 500 });
        }
    }
};
