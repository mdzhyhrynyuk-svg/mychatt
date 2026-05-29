const localHostnames = new Set(["localhost", "127.0.0.1"]);
const defaultSignalServer = localHostnames.has(location.hostname)
  ? location.origin
  : window.ERMI_SIGNAL_SERVER || window.ARMY_CHAT_SIGNAL_SERVER;

const landingView = document.getElementById("landingView");
const appView = document.getElementById("appView");
const heroStartButton = document.getElementById("heroStartButton");
const topStartButton = document.getElementById("topStartButton");
const previewButton = document.getElementById("previewButton");
const backHomeButton = document.getElementById("backHomeButton");
const enableMediaButton = document.getElementById("enableMediaButton");
const connectButton = document.getElementById("connectButton");
const nextButton = document.getElementById("nextButton");
const toggleMicButton = document.getElementById("toggleMicButton");
const toggleCameraButton = document.getElementById("toggleCameraButton");
const endButton = document.getElementById("endButton");
const reportButton = document.getElementById("reportButton");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const localEmpty = document.getElementById("localEmpty");
const remoteEmpty = document.getElementById("remoteEmpty");
const localDot = document.getElementById("localDot");
const remoteDot = document.getElementById("remoteDot");
const remoteLabel = document.getElementById("remoteLabel");
const statusPill = document.getElementById("statusPill");
const statusText = document.getElementById("statusText");
const tagGrid = document.getElementById("tagGrid");
const queueCount = document.getElementById("queueCount");
const roomMeta = document.getElementById("roomMeta");
const pingState = document.getElementById("pingState");
const chatForm = document.getElementById("chatForm");
const chatLog = document.getElementById("chatLog");
const messageInput = document.getElementById("messageInput");
const reportDialog = document.getElementById("reportDialog");
const reportReason = document.getElementById("reportReason");
const submitReportButton = document.getElementById("submitReportButton");

let socket = null;
let localStream = null;
let peerConnection = null;
let roomId = null;
let micEnabled = true;
let cameraEnabled = true;
let selectedTags = new Set(["music"]);
let isMatching = false;

const iceServers = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" }
];

function setStatus(text, tone = "muted") {
  statusText.textContent = text;
  const dot = statusPill.querySelector(".live-dot");
  dot.className = `live-dot ${tone}`;
}

function setRemoteState(label, tone = "muted") {
  remoteLabel.textContent = label;
  remoteDot.className = `live-dot ${tone}`;
}

function showPlatform() {
  landingView.hidden = true;
  appView.hidden = false;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showLanding() {
  appView.hidden = true;
  landingView.hidden = false;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      resolve();
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Не удалось загрузить ${src}`));
    document.head.appendChild(script);
  });
}

async function ensureSocketClient() {
  if (window.io) return;

  if (!defaultSignalServer) {
    throw new Error("Не задан адрес signaling-сервера в public/config.js.");
  }

  await loadScript(`${defaultSignalServer}/socket.io/socket.io.js`);
}

async function connectSocket() {
  if (socket?.connected) return;

  await ensureSocketClient();

  socket = io(defaultSignalServer, {
    transports: ["websocket", "polling"]
  });

  socket.on("connect", () => {
    setStatus("Сервер ERMI подключен", "");
  });

  socket.on("connect_error", (error) => {
    setStatus(`Ошибка сервера: ${error.message}`, "danger");
  });

  socket.on("queue-count", ({ waiting }) => {
    queueCount.textContent = String(waiting);
  });

  socket.on("waiting", ({ waiting }) => {
    isMatching = true;
    queueCount.textContent = String(waiting);
    setStatus("Ищем собеседника", "busy");
    setRemoteState("Поиск", "busy");
    remoteEmpty.hidden = false;
  });

  socket.on("matched", ({ roomId: matchedRoomId, isCaller }) => {
    roomId = matchedRoomId;
    isMatching = false;
    roomMeta.textContent = shortRoom(roomId);
    setStatus("Собеседник найден. Создаем звонок", "busy");
    setRemoteState("Подключение", "busy");
    addSystemMessage("Собеседник найден. Начинаем WebRTC-соединение.");

    if (isCaller) {
      makeOffer();
    }
  });

  socket.on("offer", async ({ offer }) => {
    if (!peerConnection) return;
    await peerConnection.setRemoteDescription(offer);
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit("answer", { roomId, answer });
  });

  socket.on("answer", async ({ answer }) => {
    if (peerConnection) {
      await peerConnection.setRemoteDescription(answer);
    }
  });

  socket.on("ice-candidate", async ({ candidate }) => {
    if (peerConnection && candidate) {
      await peerConnection.addIceCandidate(candidate);
    }
  });

  socket.on("chat-message", ({ message }) => {
    addMessage(message, "peer");
  });

  socket.on("report-received", () => {
    addSystemMessage("Жалоба отправлена. Переключаем на следующего собеседника.");
  });

  socket.on("peer-left", () => {
    remoteVideo.srcObject = null;
    remoteEmpty.hidden = false;
    nextButton.disabled = false;
    reportButton.disabled = true;
    setRemoteState("Собеседник вышел", "muted");
    setStatus("Собеседник вышел. Можно нажать Next", "muted");
    addSystemMessage("Собеседник завершил разговор.");
  });
}

async function startCamera() {
  if (localStream) return;

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Браузер не поддерживает доступ к камере.");
  }

  localStream = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: true
  });

  localVideo.srcObject = localStream;
  localEmpty.hidden = true;
  localDot.className = "live-dot";
  toggleMicButton.disabled = false;
  toggleCameraButton.disabled = false;
  setStatus("Камера и микрофон включены", "");
}

function stopCamera() {
  if (!localStream) return;

  localStream.getTracks().forEach((track) => track.stop());
  localStream = null;
  localVideo.srcObject = null;
  localEmpty.hidden = false;
  localDot.className = "live-dot muted";
  toggleMicButton.disabled = true;
  toggleCameraButton.disabled = true;
}

function createPeerConnection() {
  cleanupPeer();
  peerConnection = new RTCPeerConnection({ iceServers });

  localStream.getTracks().forEach((track) => {
    peerConnection.addTrack(track, localStream);
  });

  peerConnection.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
    remoteEmpty.hidden = true;
    nextButton.disabled = false;
    reportButton.disabled = false;
    endButton.disabled = false;
    setRemoteState("В эфире", "");
    setStatus("Разговор идет", "");
    pingState.textContent = "P2P";
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("ice-candidate", {
        roomId,
        candidate: event.candidate
      });
    }
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    pingState.textContent = state.toUpperCase();

    if (state === "connected") {
      setStatus("Разговор идет", "");
      setRemoteState("В эфире", "");
      return;
    }

    if (state === "failed" || state === "disconnected") {
      setStatus(`Соединение: ${state}`, "danger");
      setRemoteState("Проблема связи", "danger");
    }
  };
}

async function makeOffer() {
  if (!peerConnection) return;

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  socket.emit("offer", { roomId, offer });
}

async function findPartner() {
  showPlatform();
  await startCamera();
  await connectSocket();

  createPeerConnection();
  clearChat();
  socket.emit("find-partner", {
    tags: [...selectedTags]
  });

  connectButton.disabled = true;
  nextButton.disabled = true;
  endButton.disabled = false;
  reportButton.disabled = true;
  roomMeta.textContent = "поиск";
  setStatus("Ищем собеседника", "busy");
  setRemoteState("Поиск", "busy");
}

function nextPartner() {
  socket?.emit("leave-room");
  cleanupPeer();
  remoteVideo.srcObject = null;
  remoteEmpty.hidden = false;
  roomId = null;
  addSystemMessage("Переходим к следующему собеседнику.");
  findPartner().catch((error) => {
    setStatus(`Ошибка Next: ${error.message}`, "danger");
  });
}

function endCall({ stopMedia = true } = {}) {
  socket?.emit("leave-room");
  cleanupPeer();
  roomId = null;
  isMatching = false;
  remoteVideo.srcObject = null;
  remoteEmpty.hidden = false;
  connectButton.disabled = false;
  nextButton.disabled = true;
  reportButton.disabled = true;
  endButton.disabled = true;
  roomMeta.textContent = "не подключено";
  pingState.textContent = "WebRTC";
  setRemoteState("Ожидание", "muted");
  setStatus("Звонок завершен", "muted");

  if (stopMedia) {
    stopCamera();
  }
}

function cleanupPeer() {
  if (!peerConnection) return;
  peerConnection.ontrack = null;
  peerConnection.onicecandidate = null;
  peerConnection.onconnectionstatechange = null;
  peerConnection.close();
  peerConnection = null;
}

function shortRoom(value) {
  if (!value) return "не подключено";
  return `room ${value.slice(0, 6)}`;
}

function addSystemMessage(text) {
  const message = document.createElement("p");
  message.className = "system-message";
  message.textContent = text;
  chatLog.appendChild(message);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function addMessage(text, owner) {
  const message = document.createElement("p");
  message.className = `message ${owner}`;
  message.textContent = text;
  chatLog.appendChild(message);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function clearChat() {
  chatLog.innerHTML = "";
  addSystemMessage("Матчинг запущен. Текстовый чат включится после соединения.");
}

function toggleTrack(kind) {
  if (!localStream) return;

  if (kind === "audio") {
    micEnabled = !micEnabled;
    localStream.getAudioTracks().forEach((track) => {
      track.enabled = micEnabled;
    });
    toggleMicButton.classList.toggle("is-off", !micEnabled);
    toggleMicButton.querySelector("span").textContent = micEnabled ? "Микрофон" : "Без звука";
  }

  if (kind === "video") {
    cameraEnabled = !cameraEnabled;
    localStream.getVideoTracks().forEach((track) => {
      track.enabled = cameraEnabled;
    });
    toggleCameraButton.classList.toggle("is-off", !cameraEnabled);
    localEmpty.hidden = cameraEnabled;
    toggleCameraButton.querySelector("span").textContent = cameraEnabled ? "Видео" : "Камера off";
  }
}

function submitReport() {
  if (!socket || !roomId) {
    reportDialog.close();
    return;
  }

  socket.emit("report-user", {
    roomId,
    reason: reportReason.value
  });

  reportDialog.close();
  nextPartner();
}

function initTags() {
  tagGrid.addEventListener("click", (event) => {
    const button = event.target.closest(".tag-button");
    if (!button) return;

    const tag = button.dataset.tag;
    if (selectedTags.has(tag)) {
      selectedTags.delete(tag);
      button.classList.remove("active");
    } else {
      selectedTags.add(tag);
      button.classList.add("active");
    }

    if (selectedTags.size === 0) {
      selectedTags.add(tag);
      button.classList.add("active");
    }
  });
}

function initHeroCanvas() {
  const canvas = document.getElementById("heroCanvas");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!canvas || reducedMotion) return;

  const context = canvas.getContext("2d");
  const points = Array.from({ length: 58 }, () => ({
    x: Math.random(),
    y: Math.random(),
    vx: (Math.random() - 0.5) * 0.0005,
    vy: (Math.random() - 0.5) * 0.0005,
    radius: 1 + Math.random() * 2.2
  }));

  function resize() {
    canvas.width = window.innerWidth * window.devicePixelRatio;
    canvas.height = window.innerHeight * window.devicePixelRatio;
  }

  function draw() {
    const width = canvas.width;
    const height = canvas.height;
    context.clearRect(0, 0, width, height);

    points.forEach((point, index) => {
      point.x += point.vx;
      point.y += point.vy;

      if (point.x < 0 || point.x > 1) point.vx *= -1;
      if (point.y < 0 || point.y > 1) point.vy *= -1;

      const x = point.x * width;
      const y = point.y * height;
      context.beginPath();
      context.arc(x, y, point.radius * window.devicePixelRatio, 0, Math.PI * 2);
      context.fillStyle = index % 3 === 0 ? "rgba(103,228,255,0.52)" : "rgba(141,92,246,0.44)";
      context.fill();

      for (let next = index + 1; next < points.length; next += 1) {
        const other = points[next];
        const otherX = other.x * width;
        const otherY = other.y * height;
        const distance = Math.hypot(x - otherX, y - otherY);

        if (distance < 150 * window.devicePixelRatio) {
          context.beginPath();
          context.moveTo(x, y);
          context.lineTo(otherX, otherY);
          context.strokeStyle = `rgba(185,168,206,${0.14 - distance / (150 * window.devicePixelRatio) * 0.12})`;
          context.lineWidth = 1;
          context.stroke();
        }
      }
    });

    requestAnimationFrame(draw);
  }

  resize();
  draw();
  window.addEventListener("resize", resize);
}

heroStartButton.addEventListener("click", () => {
  findPartner().catch((error) => setStatus(`Ошибка запуска: ${error.message}`, "danger"));
});

topStartButton.addEventListener("click", () => {
  findPartner().catch((error) => setStatus(`Ошибка запуска: ${error.message}`, "danger"));
});

previewButton.addEventListener("click", showPlatform);
backHomeButton.addEventListener("click", () => {
  endCall();
  showLanding();
});

enableMediaButton.addEventListener("click", () => {
  startCamera().catch((error) => setStatus(`Ошибка камеры: ${error.message}`, "danger"));
});

connectButton.addEventListener("click", () => {
  findPartner().catch((error) => setStatus(`Ошибка подключения: ${error.message}`, "danger"));
});

nextButton.addEventListener("click", nextPartner);
endButton.addEventListener("click", () => endCall());
toggleMicButton.addEventListener("click", () => toggleTrack("audio"));
toggleCameraButton.addEventListener("click", () => toggleTrack("video"));

reportButton.addEventListener("click", () => {
  reportDialog.showModal();
});

submitReportButton.addEventListener("click", submitReport);

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const message = messageInput.value.trim();
  if (!message) return;

  if (!socket || !roomId) {
    addSystemMessage("Сначала подключись к собеседнику.");
    return;
  }

  socket.emit("chat-message", { roomId, message });
  addMessage(message, "me");
  messageInput.value = "";
});

document.addEventListener("keydown", (event) => {
  const isTyping = event.target.matches("input, textarea, select");
  if (isTyping) return;

  if (event.key === "Escape" && !endButton.disabled) {
    endCall();
  }

  if (event.key === "ArrowRight" && !nextButton.disabled) {
    nextPartner();
  }
});

initTags();
initHeroCanvas();
setStatus("Готов к запуску", "muted");
