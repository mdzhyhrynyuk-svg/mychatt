import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

const rooms = new Map();
const waitingQueue = [];

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }
  return rooms.get(roomId);
}

function removeFromQueue(socket) {
  const index = waitingQueue.findIndex((waiting) => waiting.id === socket.id);
  if (index !== -1) {
    waitingQueue.splice(index, 1);
  }
}

function getSharedTagScore(firstTags = [], secondTags = []) {
  const secondSet = new Set(secondTags);
  return firstTags.filter((tag) => secondSet.has(tag)).length;
}

function findQueuedPartner(tags) {
  let bestIndex = -1;
  let bestScore = -1;

  for (let index = 0; index < waitingQueue.length; index += 1) {
    const candidate = waitingQueue[index];
    if (!candidate.connected) continue;

    const score = getSharedTagScore(tags, candidate.data.tags);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function emitQueueCount() {
  io.emit("queue-count", {
    waiting: waitingQueue.filter((socket) => socket.connected).length
  });
}

function leaveCurrentRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId || !rooms.has(roomId)) return;

  const room = rooms.get(roomId);
  room.delete(socket.id);
  socket.leave(roomId);
  socket.to(roomId).emit("peer-left");
  socket.data.roomId = null;

  if (room.size === 0) {
    rooms.delete(roomId);
  }
}

io.on("connection", (socket) => {
  socket.on("find-partner", ({ tags = [] } = {}) => {
    removeFromQueue(socket);

    leaveCurrentRoom(socket);

    const cleanTags = Array.isArray(tags)
      ? tags.map((tag) => String(tag).slice(0, 30)).slice(0, 8)
      : [];

    socket.data.tags = cleanTags;

    const partnerIndex = findQueuedPartner(cleanTags);

    if (partnerIndex !== -1) {
      const partner = waitingQueue.splice(partnerIndex, 1)[0];
      const roomId = `${partner.id}-${socket.id}`;
      const room = getRoom(roomId);

      room.add(partner.id);
      room.add(socket.id);

      partner.join(roomId);
      socket.join(roomId);
      partner.data.roomId = roomId;
      socket.data.roomId = roomId;

      partner.emit("matched", { roomId, isCaller: true });
      socket.emit("matched", { roomId, isCaller: false });
      emitQueueCount();
      return;
    }

    waitingQueue.push(socket);
    socket.emit("waiting", {
      waiting: waitingQueue.length
    });
    emitQueueCount();
  });

  socket.on("join-room", ({ roomId }) => {
    const room = getRoom(roomId);

    if (room.size >= 2) {
      socket.emit("room-full");
      return;
    }

    socket.join(roomId);
    room.add(socket.id);
    socket.data.roomId = roomId;

    socket.emit("joined-room", {
      roomId,
      isCaller: room.size === 2
    });

    if (room.size === 2) {
      socket.to(roomId).emit("peer-joined");
    }
  });

  socket.on("leave-room", () => {
    removeFromQueue(socket);
    leaveCurrentRoom(socket);
    emitQueueCount();
  });

  socket.on("offer", ({ roomId, offer }) => {
    socket.to(roomId).emit("offer", { offer });
  });

  socket.on("answer", ({ roomId, answer }) => {
    socket.to(roomId).emit("answer", { answer });
  });

  socket.on("ice-candidate", ({ roomId, candidate }) => {
    socket.to(roomId).emit("ice-candidate", { candidate });
  });

  socket.on("chat-message", ({ roomId, message }) => {
    const cleanMessage = String(message || "").trim().slice(0, 240);
    if (!roomId || !cleanMessage) return;

    socket.to(roomId).emit("chat-message", {
      message: cleanMessage
    });
  });

  socket.on("report-user", ({ roomId, reason }) => {
    const cleanReason = String(reason || "other").slice(0, 40);
    console.log("Report received", {
      roomId,
      reason: cleanReason,
      reporter: socket.id,
      at: new Date().toISOString()
    });

    socket.emit("report-received");
  });

  socket.on("disconnect", () => {
    removeFromQueue(socket);
    if (socket.data.roomId) {
      leaveCurrentRoom(socket);
    }

    emitQueueCount();
  });
});

server.listen(PORT, () => {
  console.log(`ERMI is running at http://localhost:${PORT}`);
});
