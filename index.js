import { Server } from "socket.io";
import { createServer } from "http";

// AniTrack Sync Hub
// Architecture mirrors Syncplay: server is a dumb relay.
// All sync logic (seek decisions, slowdown, drift correction) happens on the client.
// Server just forwards state between room members and tracks who is in which room.

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200);
    res.end("ok");
  }
});

const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// { roomId: { users: { [username]: { position, paused, ts } }, playlist, ... } }
const rooms = {};
// { socketId: { roomId, username } }
const socketMeta = {};

function getRoom(id) {
  if (!rooms[id]) {
    rooms[id] = {
      playlist: [],
      currentIndex: 0,
      readyUsers: {},
    };
  }
  return rooms[id];
}

io.on("connection", (socket) => {

  // ── Join ────────────────────────────────────────────────────────────────────

  socket.on("join-room", (roomId, username) => {
    socket.join(roomId);
    socketMeta[socket.id] = { roomId, username };
    const room = getRoom(roomId);
    if (username) room.readyUsers[username] = room.readyUsers[username] ?? false;
    io.to(roomId).emit("playlist-updated", room);
    // Notify others
    socket.to(roomId).emit("message", { sender: "system", text: `${username} joined the room`, system: true });
  });

  // ── State relay (core sync mechanism, mirrors Syncplay protocol) ─────────────
  // Client sends: { roomId, position, paused, doSeek, ignoringOnTheFly }
  // Server relays to everyone else in the room — clients decide what to do with it
  socket.on("state", ({ roomId, position, paused, doSeek, setBy, ignoringOnTheFly }) => {
    socket.to(roomId).emit("state", { position, paused, doSeek, setBy, ignoringOnTheFly });
  });

  // ── Playlist events ──────────────────────────────────────────────────────────

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

  // ── Leave / Disconnect ───────────────────────────────────────────────────────

  function userLeft(roomId, username) {
    const room = rooms[roomId];
    if (!room || !username) return;
    delete room.readyUsers[username];
    io.to(roomId).emit("playlist-updated", room);
    io.to(roomId).emit("message", { sender: "system", text: `${username} left the room`, system: true });
  }

  socket.on("leave-room", ({ roomId, username }) => {
    userLeft(roomId, username);
    socket.leave(roomId);
    delete socketMeta[socket.id];
  });

  socket.on("disconnect", () => {
    const meta = socketMeta[socket.id];
    if (meta) {
      userLeft(meta.roomId, meta.username);
      delete socketMeta[socket.id];
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`✔ AniTrack Hub running on port ${PORT}`);
});
