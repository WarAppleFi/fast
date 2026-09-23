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

const keys = {};
let moveForward = false;
let moveBackward = false;
let moveLeft = false;
let moveRight = false;

window.addEventListener('keydown', (event) => {
  if (event.code === 'KeyW') moveForward = true;
  if (event.code === 'KeyS') moveBackward = true;
  if (event.code === 'KeyA') moveLeft = true;
  if (event.code === 'KeyD') moveRight = true;
  if (event.code === 'Escape') {
    document.exitPointerLock?.();
  }
});

window.addEventListener('keyup', (event) => {
  if (event.code === 'KeyW') moveForward = false;
  if (event.code === 'KeyS') moveBackward = false;
  if (event.code === 'KeyA') moveLeft = false;
  if (event.code === 'KeyD') moveRight = false;
});

overlay.addEventListener('click', () => {
  overlay.style.display = 'none';
  document.body.requestPointerLock();
});

document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === document.body) {
    overlay.style.display = 'none';
  }
});

document.addEventListener('mousemove', (event) => {
  if (document.pointerLockElement !== document.body) return;
  yaw -= event.movementX * 0.0025;
  pitch = Math.max(-1.2, Math.min(1.2, pitch - event.movementY * 0.0025));
  playerGroup.rotation.y = yaw;
  camera.rotation.x = pitch;
});

// ===== НОВОЕ: Управление геймпадом =====
let gamepadIndex = null;
let gamepadConnected = false;

window.addEventListener('gamepadconnected', (event) => {
  console.log('Геймпад подключен:', event.gamepad.id);
  gamepadIndex = event.gamepad.index;
  gamepadConnected = true;
  
  // Показываем уведомление о подключении
  const notification = document.createElement('div');
  notification.textContent = 'Геймпад подключен!';
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(56, 189, 248, 0.9);
    color: white;
    padding: 10px 20px;
    border-radius: 5px;
    font-family: Arial, sans-serif;
    z-index: 1000;
    animation: fadeOut 3s forwards;
  `;
  
  // Добавляем анимацию исчезновения
  const style = document.createElement('style');
  style.textContent = `
    @keyframes fadeOut {
      0% { opacity: 1; }
      70% { opacity: 1; }
      100% { opacity: 0; }
    }
  `;
  document.head.appendChild(style);
  
  document.body.appendChild(notification);
  setTimeout(() => notification.remove(), 3000);
});

window.addEventListener('gamepaddisconnected', (event) => {
  console.log('Геймпад отключен:', event.gamepad.id);
  if (gamepadIndex === event.gamepad.index) {
    gamepadIndex = null;
    gamepadConnected = false;
  }
});

function getGamepadInput() {
  if (!gamepadConnected || gamepadIndex === null) {
    return { moveX: 0, moveY: 0, lookX: 0, lookY: 0 };
  }
  
  const gamepad = navigator.getGamepads()[gamepadIndex];
  if (!gamepad) {
    gamepadConnected = false;
    gamepadIndex = null;
    return { moveX: 0, moveY: 0, lookX: 0, lookY: 0 };
  }
  
  // Стандартная раскладка геймпада:
  // Левый стик (оси 0, 1): движение
  // Правый стик (оси 2, 3): камера
  // Кнопка A (0): можно использовать для действий
  
  const deadzone = 0.15; // Мёртвая зона для стиков
  
  let moveX = gamepad.axes[0] || 0; // Левый стик X
  let moveY = gamepad.axes[1] || 0; // Левый стик Y
  
  let lookX = gamepad.axes[2] || 0; // Правый стик X
  let lookY = gamepad.axes[3] || 0; // Правый стик Y
  
  // Применяем мёртвую зону
  if (Math.abs(moveX) < deadzone) moveX = 0;
  if (Math.abs(moveY) < deadzone) moveY = 0;
  if (Math.abs(lookX) < deadzone) lookX = 0;
  if (Math.abs(lookY) < deadzone) lookY = 0;
  
  return { moveX, moveY, lookX, lookY };
}

// ==========================================

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

let socket;

function connect() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

  socket.addEventListener('open', () => {
    console.log('Connected');
  });

  socket.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'welcome') {
      myId = data.id;
      const existing = Array.from(remotePlayers.keys());
      for (const id of existing) removeRemotePlayer(id);
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

  socket.addEventListener('close', () => {
    overlay.textContent = 'Соединение разорвано. Перезагрузите страницу.';
    overlay.style.display = 'flex';
  });
}

connect();

let lastSent = 0;
function animate(now) {
  requestAnimationFrame(animate);

  const delta = Math.min(0.05, (now - (animate.lastTime || now)) / 1000);
  animate.lastTime = now;

  const moveSpeed = 6 * delta;
  const direction = new THREE.Vector3();
  const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));

  // Обработка клавиатуры
  if (moveForward) direction.add(forward);
  if (moveBackward) direction.sub(forward);
  if (moveLeft) direction.sub(right);
  if (moveRight) direction.add(right);

  // ===== НОВОЕ: Обработка геймпада =====
  const gamepadInput = getGamepadInput();
  
  // Движение от геймпада (левый стик)
  if (gamepadInput.moveX !== 0 || gamepadInput.moveY !== 0) {
    // Инвертируем Y, так как вверх на стике это отрицательное значение
    const gamepadMoveX = -gamepadInput.moveX;
    const gamepadMoveY = -gamepadInput.moveY;
    
    direction.x += gamepadMoveX * right.x + gamepadMoveY * forward.x;
    direction.z += gamepadMoveX * right.z + gamepadMoveY * forward.z;
  }
  
  // Поворот камеры от геймпада (правый стик)
  if (gamepadInput.lookX !== 0 || gamepadInput.lookY !== 0) {
    const lookSpeed = 2.0 * delta; // Скорость поворота камеры
    yaw -= gamepadInput.lookX * lookSpeed;
    pitch = Math.max(-1.2, Math.min(1.2, pitch - gamepadInput.lookY * lookSpeed));
    playerGroup.rotation.y = yaw;
    camera.rotation.x = pitch;
  }
  // ==========================================

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

  if (socket && socket.readyState === WebSocket.OPEN) {
    if (now - lastSent > 50) {
      socket.send(JSON.stringify({
        type: 'update',
        x: playerGroup.position.x,
        z: playerGroup.position.z,
        yaw: playerGroup.rotation.y
      }));
      lastSent = now;
    }
  }

  renderer.render(scene, camera);
}

requestAnimationFrame(animate);
