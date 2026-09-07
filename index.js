import { Server } from "socket.io";
import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";

const SETTINGS_FILE = "./settings-store.json";

function loadStore() {
  try {
    if (existsSync(SETTINGS_FILE)) return JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
  } catch {}
  return {};
}

function saveStore(store) {
  try { writeFileSync(SETTINGS_FILE, JSON.stringify(store), "utf8"); } catch {}
}

const settingsStore = loadStore(); // { [username]: { iv, data, updatedAt } }

const httpServer = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.url === "/health") {
    res.writeHead(200);
    res.end("ok");
    return;
  }

  // GET /settings/:username — fetch encrypted blob
  const getMatch = req.url?.match(/^\/settings\/([^/]+)$/);
  if (req.method === "GET" && getMatch) {
    const username = decodeURIComponent(getMatch[1]);
    const entry = settingsStore[username];
    if (!entry) { res.writeHead(404); res.end(JSON.stringify({ error: "Not found" })); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(entry));
    return;
  }

  // POST /settings/:username — store encrypted blob
  const postMatch = req.url?.match(/^\/settings\/([^/]+)$/);
  if (req.method === "POST" && postMatch) {
    const username = decodeURIComponent(postMatch[1]);
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const { iv, data } = JSON.parse(body);
        if (!iv || !data) { res.writeHead(400); res.end(JSON.stringify({ error: "iv and data required" })); return; }
        settingsStore[username] = { iv, data, updatedAt: new Date().toISOString() };
        saveStore(settingsStore);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return;
  }

  res.writeHead(404); res.end("Not found");
});

const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const roomStates = {};
const socketMeta = {};

function getRoom(id) {
  if (!roomStates[id]) {
    roomStates[id] = { playlist: [], currentIndex: 0, readyUsers: {}, host: null };
  }
  return roomStates[id];
}

io.on("connection", (socket) => {

  socket.on("join-room", (id, username) => {
    socket.join(id);
    const room = getRoom(id);
    if (username) {
      room.readyUsers[username] = room.readyUsers[username] ?? false;
      socketMeta[socket.id] = { roomId: id, username };
      if (!room.host) room.host = username;
    }
    io.to(id).emit("playlist-updated", room);
    io.to(id).emit("host-changed", { host: room.host });
  });

  socket.on("add-to-playlist", ({ roomId, item }) => {
    const room = getRoom(roomId);
    room.playlist.push(item);
    io.to(roomId).emit("playlist-updated", room);
  });

  socket.on("remove-from-playlist", ({ roomId, index }) => {
    const room = getRoom(roomId);
    room.playlist.splice(index, 1);
    io.to(roomId).emit("playlist-updated", room);
  });

  socket.on("clear-playlist", ({ roomId }) => {
    const room = getRoom(roomId);
    room.playlist = [];
    room.currentIndex = 0;
    room.readyUsers = {};
    io.to(roomId).emit("playlist-updated", room);
  });

  socket.on("toggle-ready", ({ roomId, user, isReady }) => {
    const room = getRoom(roomId);
    room.readyUsers[user] = isReady;
    io.to(roomId).emit("playlist-updated", room);
  });

  socket.on("launch-specific", ({ roomId, mediaId, epNum }) => {
    const room = getRoom(roomId);
    const idx = room.playlist.findIndex(i => i.mediaId === mediaId && i.epNum === epNum);
    if (idx !== -1) room.currentIndex = idx;
    io.to(roomId).emit("playlist-updated", room);
    io.to(roomId).emit("auto-launch-request", { mediaId, epNum });
  });

  socket.on("message", (data) => {
    io.to(data.roomId).emit("message", data);
  });

  socket.on("state", (data) => {
    const meta = socketMeta[socket.id];
    if (!meta) return;
    socket.to(meta.roomId).emit("state", { ...data, ts: Date.now() });
  });

  socket.on("disconnect", () => {
    const meta = socketMeta[socket.id];
    if (meta) {
      const { roomId, username } = meta;
      const room = roomStates[roomId];
      if (room && username) {
        delete room.readyUsers[username];
        if (room.host === username) {
          const remaining = Object.keys(room.readyUsers);
          room.host = remaining.length > 0 ? remaining[0] : null;
          io.to(roomId).emit("host-changed", { host: room.host });
        }
        io.to(roomId).emit("playlist-updated", room);
      }
      delete socketMeta[socket.id];
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log("AniTrack Hub running on port " + PORT);
});
