// ERMI v8: separate landing and platform pages with resilient WebRTC handling.
const localHostnames = new Set(["localhost", "127.0.0.1"]);
const defaultSignalServer = localHostnames.has(location.hostname)
  ? location.origin
  : window.ERMI_SIGNAL_SERVER || window.ARMY_CHAT_SIGNAL_SERVER;

const byId = (id) => document.getElementById(id);

const enableMediaButton = byId("enableMediaButton");
const connectButton = byId("connectButton");
const nextButton = byId("nextButton");
const toggleMicButton = byId("toggleMicButton");
const toggleCameraButton = byId("toggleCameraButton");
const endButton = byId("endButton");
const reportButton = byId("reportButton");
const localVideo = byId("localVideo");
const remoteVideo = byId("remoteVideo");
const localFrame = byId("localFrame");
const remoteFrame = byId("remoteFrame");
const localEmpty = byId("localEmpty");
const remoteEmpty = byId("remoteEmpty");
const localDot = byId("localDot");
const remoteDot = byId("remoteDot");
const remoteLabel = byId("remoteLabel");
const statusPill = byId("statusPill");
const statusText = byId("statusText");
const queueCount = byId("queueCount");
const roomMeta = byId("roomMeta");
const pingState = byId("pingState");
const chatForm = byId("chatForm");
const chatLog = byId("chatLog");
const messageInput = byId("messageInput");
const reportDialog = byId("reportDialog");
const reportReason = byId("reportReason");
const submitReportButton = byId("submitReportButton");

const isPlatformPage = Boolean(connectButton && localVideo && remoteVideo);

let socket = null;
let localStream = null;
let remoteStream = null;
let peerConnection = null;
let roomId = null;
let micEnabled = true;
let cameraEnabled = true;
let selectedTags = new Set(["global"]);
let isMatching = false;
let connectionTimer = null;
let pendingCandidates = [];

const iceServers = window.ERMI_ICE_SERVERS || [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" }
];

function setButtonText(button, text) {
  const label = button?.querySelector("span");
  if (label) label.textContent = text;
}

function setStatus(text, tone = "muted") {
  if (!statusText || !statusPill) return;
  statusText.textContent = text;
  const dot = statusPill.querySelector(".live-dot");
  if (dot) dot.className = `live-dot ${tone}`;
}

function setRemoteState(label, tone = "muted") {
  if (!remoteLabel || !remoteDot) return;
  remoteLabel.textContent = label;
  remoteDot.className = `live-dot ${tone}`;
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
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(script);
  });
}

async function ensureSocketClient() {
  if (window.io) return;

  if (!defaultSignalServer) {
    throw new Error("Signal server is missing in public/config.js.");
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
    setStatus("ERMI server connected", "");
  });

  socket.on("connect_error", (error) => {
    connectButton.disabled = false;
    endButton.disabled = true;
    setStatus(`Server error: ${error.message}`, "danger");
  });

  socket.on("queue-count", ({ waiting }) => {
    queueCount.textContent = String(waiting);
  });

  socket.on("waiting", ({ waiting }) => {
    isMatching = true;
    queueCount.textContent = String(waiting);
    setStatus("Searching for a live partner", "busy");
    setRemoteState("Searching", "busy");
    hideRemoteVideo();
  });

  socket.on("matched", ({ roomId: matchedRoomId, isCaller }) => {
    roomId = matchedRoomId;
    isMatching = false;
    roomMeta.textContent = shortRoom(roomId);
    setStatus("Partner found. Opening room", "busy");
    setRemoteState("Connecting", "busy");
    addSystemMessage("Partner found. Building the WebRTC connection.");
    startConnectionTimer();

    if (isCaller) {
      makeOffer();
    }
  });

  socket.on("offer", async ({ offer }) => {
    if (!peerConnection) return;
    try {
      await peerConnection.setRemoteDescription(offer);
      await flushPendingCandidates();
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit("answer", { roomId, answer });
    } catch (error) {
      handleConnectionProblem(`Offer error: ${error.message}`);
    }
  });

  socket.on("answer", async ({ answer }) => {
    if (!peerConnection) return;
    try {
      await peerConnection.setRemoteDescription(answer);
      await flushPendingCandidates();
    } catch (error) {
      handleConnectionProblem(`Answer error: ${error.message}`);
    }
  });

  socket.on("ice-candidate", async ({ candidate }) => {
    if (!peerConnection || !candidate) return;
    try {
      if (!peerConnection.remoteDescription) {
        pendingCandidates.push(candidate);
        return;
      }

      await peerConnection.addIceCandidate(candidate);
    } catch (error) {
      handleConnectionProblem(`ICE error: ${error.message}`);
    }
  });

  socket.on("chat-message", ({ message }) => {
    addMessage(message, "peer");
  });

  socket.on("report-received", () => {
    addSystemMessage("Report sent. Moving to the next partner.");
  });

  socket.on("peer-left", () => {
    stopConnectionTimer();
    hideRemoteVideo();
    nextButton.disabled = false;
    reportButton.disabled = true;
    setRemoteState("Partner left", "muted");
    setStatus("Partner left. Press Next to search again", "muted");
    addSystemMessage("Partner ended the room.");
  });
}

async function startCamera() {
  if (localStream) return;

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser does not support camera access.");
  }

  localStream = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: true
  });

  localVideo.srcObject = localStream;
  await localVideo.play().catch(() => {});
  localEmpty.hidden = true;
  localFrame.classList.add("has-stream");
  localDot.className = "live-dot";
  toggleMicButton.disabled = false;
  toggleCameraButton.disabled = false;
  setStatus("Camera and microphone are on", "");
}

function stopCamera() {
  if (!localStream) return;

  localStream.getTracks().forEach((track) => track.stop());
  localStream = null;
  localVideo.srcObject = null;
  localEmpty.hidden = false;
  localFrame.classList.remove("has-stream");
  localDot.className = "live-dot muted";
  toggleMicButton.disabled = true;
  toggleCameraButton.disabled = true;
}

function createPeerConnection() {
  cleanupPeer();
  pendingCandidates = [];
  peerConnection = new RTCPeerConnection({
    iceServers,
    iceCandidatePoolSize: 10
  });
  remoteStream = new MediaStream();
  remoteVideo.srcObject = remoteStream;

  localStream.getTracks().forEach((track) => {
    peerConnection.addTrack(track, localStream);
  });

  peerConnection.ontrack = (event) => {
    stopConnectionTimer();

    if (event.streams?.[0]) {
      remoteStream = event.streams[0];
      remoteVideo.srcObject = remoteStream;
    } else if (remoteStream && !remoteStream.getTracks().includes(event.track)) {
      remoteStream.addTrack(event.track);
      remoteVideo.srcObject = remoteStream;
    }

    event.track.onunmute = showRemoteVideo;
    showRemoteVideo();
    nextButton.disabled = false;
    reportButton.disabled = false;
    endButton.disabled = false;
    setRemoteState("Live", "");
    setStatus("Room is live", "");
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
      stopConnectionTimer();
      setStatus("Room is live", "");
      setRemoteState("Live", "");
      return;
    }

    if (state === "failed" || state === "disconnected") {
      handleConnectionProblem("Connection failed. Press Next or try another network.");
    }
  };
}

function showRemoteVideo() {
  remoteEmpty.hidden = true;
  remoteFrame.classList.add("has-stream");
  requestAnimationFrame(() => {
    remoteVideo.play().catch(() => {});
  });
}

function hideRemoteVideo() {
  if (!remoteVideo) return;
  remoteVideo.pause();
  remoteVideo.srcObject = null;
  remoteStream = null;
  remoteEmpty.hidden = false;
  remoteFrame.classList.remove("has-stream");
}

async function flushPendingCandidates() {
  if (!peerConnection?.remoteDescription || pendingCandidates.length === 0) return;

  const candidates = [...pendingCandidates];
  pendingCandidates = [];

  for (const candidate of candidates) {
    await peerConnection.addIceCandidate(candidate);
  }
}

function handleConnectionProblem(message) {
  connectButton.disabled = false;
  setButtonText(connectButton, "Start matching");
  nextButton.disabled = false;
  reportButton.disabled = true;
  stopConnectionTimer();
  setStatus(message, "danger");
  setRemoteState("No signal", "danger");
  addSystemMessage("Connection is unstable. If you test across different networks, a TURN server may be needed.");
}

async function makeOffer() {
  if (!peerConnection) return;

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  socket.emit("offer", { roomId, offer });
}

async function findPartner() {
  connectButton.disabled = true;
  setButtonText(connectButton, "Searching");

  try {
    await startCamera();
    await connectSocket();
  } catch (error) {
    connectButton.disabled = false;
    setButtonText(connectButton, "Start matching");
    endButton.disabled = true;
    throw error;
  }

  createPeerConnection();
  clearChat();
  socket.emit("find-partner", {
    tags: [...selectedTags]
  });

  nextButton.disabled = true;
  endButton.disabled = false;
  reportButton.disabled = true;
  roomMeta.textContent = "searching";
  setStatus("Searching for a live partner", "busy");
  setRemoteState("Searching", "busy");
}

function nextPartner() {
  socket?.emit("leave-room");
  cleanupPeer();
  hideRemoteVideo();
  roomId = null;
  addSystemMessage("Searching for the next partner.");
  findPartner().catch((error) => {
    setStatus(`Next error: ${error.message}`, "danger");
  });
}

function endCall({ stopMedia = true } = {}) {
  stopConnectionTimer();
  socket?.emit("leave-room");
  cleanupPeer();
  roomId = null;
  isMatching = false;
  hideRemoteVideo();
  connectButton.disabled = false;
  setButtonText(connectButton, "Start matching");
  nextButton.disabled = true;
  reportButton.disabled = true;
  endButton.disabled = true;
  roomMeta.textContent = "not connected";
  pingState.textContent = "WebRTC";
  setRemoteState("Waiting", "muted");
  setStatus("Room ended", "muted");

  if (stopMedia) {
    stopCamera();
  }
}

function cleanupPeer() {
  stopConnectionTimer();
  pendingCandidates = [];
  remoteStream = null;
  if (!peerConnection) return;
  peerConnection.ontrack = null;
  peerConnection.onicecandidate = null;
  peerConnection.onconnectionstatechange = null;
  peerConnection.close();
  peerConnection = null;
}

function startConnectionTimer() {
  stopConnectionTimer();
  connectionTimer = window.setTimeout(() => {
    if (!peerConnection || peerConnection.connectionState === "connected") return;

    connectButton.disabled = false;
    setButtonText(connectButton, "Start matching");
    nextButton.disabled = false;
    reportButton.disabled = true;
    setStatus("Connection timed out. Press Next", "danger");
    setRemoteState("No signal", "danger");
    addSystemMessage("Connection did not open in 18 seconds. This can happen without a TURN server.");
  }, 18000);
}

function stopConnectionTimer() {
  if (!connectionTimer) return;
  window.clearTimeout(connectionTimer);
  connectionTimer = null;
}

function shortRoom(value) {
  if (!value) return "not connected";
  return `room ${value.slice(0, 6)}`;
}

function addSystemMessage(text) {
  if (!chatLog) return;
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
  addSystemMessage("Matching started. Text chat will work after the room opens.");
}

function toggleTrack(kind) {
  if (!localStream) return;

  if (kind === "audio") {
    micEnabled = !micEnabled;
    localStream.getAudioTracks().forEach((track) => {
      track.enabled = micEnabled;
    });
    toggleMicButton.classList.toggle("is-off", !micEnabled);
    setButtonText(toggleMicButton, micEnabled ? "Mic" : "Muted");
  }

  if (kind === "video") {
    cameraEnabled = !cameraEnabled;
    localStream.getVideoTracks().forEach((track) => {
      track.enabled = cameraEnabled;
    });
    toggleCameraButton.classList.toggle("is-off", !cameraEnabled);
    localEmpty.hidden = cameraEnabled;
    localFrame.classList.toggle("has-stream", cameraEnabled);
    setButtonText(toggleCameraButton, cameraEnabled ? "Cam" : "Off");
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

function initPlatform() {
  enableMediaButton.addEventListener("click", () => {
    startCamera().catch((error) => setStatus(`Camera error: ${error.message}`, "danger"));
  });

  connectButton.addEventListener("click", () => {
    findPartner().catch((error) => setStatus(`Connection error: ${error.message}`, "danger"));
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
      addSystemMessage("Connect to a partner first.");
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

  if (new URLSearchParams(location.search).has("start")) {
    setStatus("Press Start matching to allow camera access", "busy");
  } else {
    setStatus("Ready", "muted");
  }
}

if (isPlatformPage) {
  initPlatform();
}
