export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.players = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);
      this.ctx.acceptWebSocket(server);

      const id = `player-${Math.random().toString(16).slice(2, 8)}`;
      const player = {
        id,
        x: 0,
        z: 0,
        yaw: 0,
        color: ['#38bdf8', '#f97316', '#a78bfa', '#22c55e', '#f43f5e'][Math.floor(Math.random() * 5)]
      };

      this.players.set(server, player);
      server.send(JSON.stringify({ type: 'welcome', id, players: Array.from(this.players.values()) }));
      this.broadcastState();

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('ok', { status: 200 });
  }

  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message.toString());
      const player = this.players.get(ws);
      if (!player || data.type !== 'update') return;

      player.x = data.x ?? player.x;
      player.z = data.z ?? player.z;
      player.yaw = data.yaw ?? player.yaw;
      this.broadcastState();
    } catch (error) {
      // ignore malformed packets
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    this.players.delete(ws);
    this.broadcastState();
  }

  broadcastState() {
    const payload = JSON.stringify({ type: 'state', players: Array.from(this.players.values()) });
    for (const ws of this.players.keys()) {
      ws.send(payload);
    }
  }
}

const HTML = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>3D Multiplayer on Cloudflare</title>
    <style>
      html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #020617; font-family: Arial, sans-serif; color: white; }
      #overlay { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(2,6,23,.8); z-index: 10; cursor: pointer; font-size: 24px; user-select: none; }
      #hud { position: fixed; left: 16px; bottom: 16px; background: rgba(15,23,42,.7); padding: 10px 12px; border-radius: 8px; font-size: 14px; z-index: 5; }
    </style>
  </head>
  <body>
    <div id="overlay">Нажмите, чтобы войти в игру</div>
    <div id="hud">WASD — движение · мышь — смотреть · клик — захватить курсор</div>
    <script src="https://unpkg.com/three@0.160.0/build/three.min.js"></script>
    <script>
      const overlay = document.getElementById('overlay');
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x020617);
      scene.fog = new THREE.Fog(0x020617, 20, 80);

      const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setSize(window.innerWidth, window.innerHeight);
      document.body.appendChild(renderer.domElement);

      const ambient = new THREE.AmbientLight(0xffffff, 0.55);
      scene.add(ambient);
      const dirLight = new THREE.DirectionalLight(0xffffff, 1.1);
      dirLight.position.set(5, 10, 7);
      scene.add(dirLight);

      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(100, 100),
        new THREE.MeshStandardMaterial({ color: 0x172033, roughness: 1 })
      );
      floor.rotation.x = -Math.PI / 2;
      scene.add(floor);

      const grid = new THREE.GridHelper(100, 100, 0x38bdf8, 0x334155);
      scene.add(grid);

      const playerGroup = new THREE.Group();
      scene.add(playerGroup);

      const playerBody = new THREE.Mesh(
        new THREE.BoxGeometry(0.6, 1.8, 0.4),
        new THREE.MeshStandardMaterial({ color: 0x38bdf8 })
      );
      playerBody.position.y = 0.9;
      playerGroup.add(playerBody);

      const cameraAnchor = new THREE.Object3D();
      cameraAnchor.position.set(0, 1.6, 0);
      playerGroup.add(cameraAnchor);
      cameraAnchor.add(camera);

      const remotePlayers = new Map();
      let myId = null;
      let yaw = 0;
      let pitch = 0;
      const moveState = { forward: false, backward: false, left: false, right: false };
      let socket = null;
      let lastSent = 0;

      window.addEventListener('keydown', (event) => {
        if (event.code === 'KeyW') moveState.forward = true;
        if (event.code === 'KeyS') moveState.backward = true;
        if (event.code === 'KeyA') moveState.left = true;
        if (event.code === 'KeyD') moveState.right = true;
      });

      window.addEventListener('keyup', (event) => {
        if (event.code === 'KeyW') moveState.forward = false;
        if (event.code === 'KeyS') moveState.backward = false;
        if (event.code === 'KeyA') moveState.left = false;
        if (event.code === 'KeyD') moveState.right = false;
      });

      overlay.addEventListener('click', () => {
        overlay.style.display = 'none';
        document.body.requestPointerLock();
      });

      document.addEventListener('pointerlockchange', () => {
        if (document.pointerLockElement === document.body) overlay.style.display = 'none';
      });

      document.addEventListener('mousemove', (event) => {
        if (document.pointerLockElement !== document.body) return;
        yaw -= event.movementX * 0.0025;
        pitch = Math.max(-1.2, Math.min(1.2, pitch - event.movementY * 0.0025));
        playerGroup.rotation.y = yaw;
        camera.rotation.x = pitch;
      });

      window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
      });

      function createRemotePlayer(id, color) {
        const state = {
          group: new THREE.Group(),
          currentPosition: new THREE.Vector3(0, 0, 0),
          targetPosition: new THREE.Vector3(0, 0, 0),
          currentYaw: 0,
          targetYaw: 0
        };

        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(0.6, 1.8, 0.4),
          new THREE.MeshStandardMaterial({ color })
        );
        mesh.position.y = 0.9;
        state.group.add(mesh);
        scene.add(state.group);
        remotePlayers.set(id, state);
        return state;
      }

      function removeRemotePlayer(id) {
        const state = remotePlayers.get(id);
        if (state) {
          scene.remove(state.group);
          remotePlayers.delete(id);
        }
      }

      function connect() {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        socket = new WebSocket(protocol + '//' + location.host + '/ws');

        socket.addEventListener('message', (event) => {
          const data = JSON.parse(event.data);
          if (data.type === 'welcome') {
            myId = data.id;
            for (const id of remotePlayers.keys()) removeRemotePlayer(id);
            for (const player of data.players) {
              if (player.id === myId) continue;
              createRemotePlayer(player.id, player.color);
            }
            return;
          }

          if (data.type === 'state') {
            const incoming = new Set(data.players.map((p) => p.id));
            for (const id of remotePlayers.keys()) {
              if (!incoming.has(id)) removeRemotePlayer(id);
            }
            for (const player of data.players) {
              if (player.id === myId) continue;
              let state = remotePlayers.get(player.id);
              if (!state) state = createRemotePlayer(player.id, player.color);
              state.targetPosition.set(player.x, 0, player.z);
              state.targetYaw = player.yaw;
            }
          }
        });
      }

      connect();

      function animate(now) {
        requestAnimationFrame(animate);
        const delta = Math.min(0.05, (now - (animate.lastTime || now)) / 1000);
        animate.lastTime = now;

        const moveSpeed = 6 * delta;
        const direction = new THREE.Vector3();
        const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
        const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));

        if (moveState.forward) direction.add(forward);
        if (moveState.backward) direction.sub(forward);
        if (moveState.left) direction.sub(right);
        if (moveState.right) direction.add(right);

        if (direction.lengthSq() > 0) {
          direction.normalize().multiplyScalar(moveSpeed);
          playerGroup.position.add(direction);
        }

        playerGroup.position.y = 0;

        for (const state of remotePlayers.values()) {
          const alpha = 1 - Math.exp(-delta * 12);
          state.currentPosition.lerp(state.targetPosition, alpha);
          state.group.position.copy(state.currentPosition);
          state.currentYaw = THREE.MathUtils.lerp(state.currentYaw, state.targetYaw, alpha);
          state.group.rotation.y = state.currentYaw;
        }

        if (socket && socket.readyState === WebSocket.OPEN && now - lastSent > 50) {
          socket.send(JSON.stringify({ type: 'update', x: playerGroup.position.x, z: playerGroup.position.z, yaw: playerGroup.rotation.y }));
          lastSent = now;
        }

        renderer.render(scene, camera);
      }

      requestAnimationFrame(animate);
    </script>
  </body>
</html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const id = env.GAME_ROOM.idFromName('default');
      const stub = env.GAME_ROOM.get(id);
      return stub.fetch(request);
    }

    if (url.pathname === '/client.js') {
      return new Response(`console.log('client loaded');`, {
        headers: { 'content-type': 'application/javascript; charset=utf-8' }
      });
    }

    return new Response(HTML, {
      headers: { 'content-type': 'text/html; charset=utf-8' }
    });
  }
};
