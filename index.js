import { Server } from "socket.io";
import { createServer } from "http";

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200);
    res.end("ok");
  }
});

const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const roomStates = {};
// Track which room and username each socket belongs to
const socketMeta = {};

function getRoom(id) {
  if (!roomStates[id]) {
    roomStates[id] = { playlist: [], currentIndex: 0, readyUsers: {} };
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
    }
    io.to(id).emit("playlist-updated", room);
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

  socket.on("disconnect", () => {
    const meta = socketMeta[socket.id];
    if (meta) {
      const { roomId, username } = meta;
      const room = roomStates[roomId];
      if (room && username) {
        delete room.readyUsers[username];
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
