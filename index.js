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

function getRoom(id) {
  if (!roomStates[id]) {
    roomStates[id] = {
      playlist: [],
      currentIndex: 0,
      readyUsers: {},
      // Sync state
      playerStatus: {},   // { [user]: { position, paused, ts } }
      syncPaused: true,   // authoritative pause state for room
      syncPosition: 0,    // authoritative position for room
      syncStartedAt: null, // wall clock when syncPaused became false
    };
  }
  return roomStates[id];
}

// ─── Sync reconciliation ──────────────────────────────────────────────────────

const SYNC_TOLERANCE = 2.5; // seconds — if more than this, force seek

function reconcile(roomId) {
  const room = roomStates[roomId];
  if (!room) return;

  const now = Date.now();
  const stale = 4000; // ignore reports older than 4s

  // Collect fresh reports
  const reports = Object.entries(room.playerStatus)
    .filter(([, s]) => now - s.ts < stale)
    .map(([user, s]) => ({ user, position: s.position, paused: s.paused }));

  if (reports.length === 0) return;

  // Authoritative position: if playing, extrapolate from when sync started
  let authPosition = room.syncPosition;
  if (!room.syncPaused && room.syncStartedAt) {
    authPosition = room.syncPosition + (now - room.syncStartedAt) / 1000;
  }

  // Tell anyone out of sync to seek
  for (const { user, position, paused } of reports) {
    const diff = Math.abs(position - authPosition);
    const wrongPause = paused !== room.syncPaused;

    if (diff > SYNC_TOLERANCE || wrongPause) {
      io.to(roomId).emit("sync-command", {
        target: user,
        position: authPosition,
        paused: room.syncPaused,
      });
    }
  }
}

// ─── Socket events ────────────────────────────────────────────────────────────

io.on("connection", (socket) => {

  socket.on("join-room", (id, username) => {
    socket.join(id);
    const room = getRoom(id);
    if (username) room.readyUsers[username] = room.readyUsers[username] ?? false;
    io.to(id).emit("playlist-updated", room);
    // Send current sync state to the new joiner
    socket.emit("sync-state", {
      position: room.syncPosition,
      paused: room.syncPaused,
    });
  });

  // ── Player status report from a client ──────────────────────────────────────
  socket.on("player-status", ({ roomId, user, position, paused }) => {
    const room = getRoom(roomId);
    room.playerStatus[user] = { position, paused, ts: Date.now() };

    // If user changed pause state, treat it as authoritative and broadcast
    if (paused !== room.syncPaused) {
      room.syncPaused = paused;
      if (!paused) {
        room.syncStartedAt = Date.now();
      } else {
        // Update position to where they paused
        room.syncPosition = position;
        room.syncStartedAt = null;
      }
      io.to(roomId).emit("sync-state", {
        position: room.syncPosition,
        paused: room.syncPaused,
      });
    }

    // If user seeked (position very different from auth), treat as authoritative
    let authPosition = room.syncPosition;
    if (!room.syncPaused && room.syncStartedAt) {
      authPosition = room.syncPosition + (Date.now() - room.syncStartedAt) / 1000;
    }
    if (Math.abs(position - authPosition) > SYNC_TOLERANCE * 2) {
      room.syncPosition = position;
      room.syncStartedAt = !paused ? Date.now() : null;
      io.to(roomId).emit("sync-state", {
        position: room.syncPosition,
        paused: room.syncPaused,
      });
    }

    reconcile(roomId);
  });

  // ── Explicit play/pause/seek from UI ────────────────────────────────────────
  socket.on("sync-play", ({ roomId, position }) => {
    const room = getRoom(roomId);
    room.syncPaused = false;
    room.syncPosition = position ?? room.syncPosition;
    room.syncStartedAt = Date.now();
    io.to(roomId).emit("sync-state", { position: room.syncPosition, paused: false });
  });

  socket.on("sync-pause", ({ roomId, position }) => {
    const room = getRoom(roomId);
    room.syncPaused = true;
    room.syncPosition = position ?? room.syncPosition;
    room.syncStartedAt = null;
    io.to(roomId).emit("sync-state", { position: room.syncPosition, paused: true });
  });

  socket.on("sync-seek", ({ roomId, position }) => {
    const room = getRoom(roomId);
    room.syncPosition = position;
    room.syncStartedAt = !room.syncPaused ? Date.now() : null;
    io.to(roomId).emit("sync-state", { position, paused: room.syncPaused });
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
    room.playerStatus = {};
    room.syncPaused = true;
    room.syncPosition = 0;
    room.syncStartedAt = null;
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
    // Reset sync state for new episode
    room.syncPaused = true;
    room.syncPosition = 0;
    room.syncStartedAt = null;
    room.playerStatus = {};
    io.to(roomId).emit("playlist-updated", room);
    io.to(roomId).emit("auto-launch-request", { mediaId, epNum });
  });

  socket.on("message", (data) => {
    io.to(data.roomId).emit("message", data);
  });

  socket.on("disconnect", () => {});
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`✔ AniTrack Hub running on port ${PORT}`);
});
