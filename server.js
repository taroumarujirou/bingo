// // server.js
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// public フォルダを静的配信
app.use(express.static(path.join(__dirname, "public")));

// ルーム情報
// rooms[roomId] = {
//   roomId,
//   hostSocketId,   // null なら「ホスト一時離脱中」
//   minNumber,
//   maxNumber,
//   drawnNumbers: [],
//   players: {
//     [secretKey]: { name, secretKey, socketId, cardNumbers }
//   }
// }
const rooms = {};

// 4桁のシークレット番号
function generateSecretKey() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// ホストに参加者一覧を送る（オンラインのみ）
function emitPlayersUpdate(roomId) {
  const room = rooms[roomId];
  if (!room || !room.hostSocketId) return;

  const players = room.players || {};
  const names = Object.values(players)
    .filter((p) => p.socketId)
    .map((p) => p.name);

  io.to(room.hostSocketId).emit("room:playersUpdate", names);
}

io.on("connection", (socket) => {
  console.log("connected:", socket.id);

  // --- ホスト：ルーム作成 or 再参加 ---
  socket.on("host:createRoom", (data, callback) => {
    const { roomId, minNumber, maxNumber } = data;
    const inputId = (roomId && roomId.trim()) || null;
    const min = Number(minNumber);
    const max = Number(maxNumber);

    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
      return callback({
        ok: false,
        message: "数字範囲が不正です。",
      });
    }

    // ① 入力された roomId が既に存在するか？
    if (inputId && rooms[inputId]) {
      const room = rooms[inputId];

      // すでにホストがオンライン
      if (room.hostSocketId) {
        return callback({
          ok: false,
          message: "このルームIDにはすでにホストがいます。",
        });
      }

      // ホスト不在だったルームに再参加
      room.hostSocketId = socket.id;
      room.minNumber = min;
      room.maxNumber = max;

      socket.data.role = "host";
      socket.data.roomId = inputId;
      socket.join(inputId);

      console.log(`host rejoin: room=${inputId}`);

      // 参加者一覧を改めて送る
      emitPlayersUpdate(inputId);

      return callback({
        ok: true,
        rejoin: true,
        room,
      });
    }

    // ② roomId が存在しない → 新規作成
    const id = inputId || Math.random().toString(36).slice(2, 8);

    rooms[id] = {
      roomId: id,
      hostSocketId: socket.id,
      minNumber: min,
      maxNumber: max,
      drawnNumbers: [],
      players: {},
    };

    socket.data.role = "host";
    socket.data.roomId = id;
    socket.join(id);

    console.log(`room created: ${id}`);

    callback({
      ok: true,
      rejoin: false,
      room: rooms[id],
    });
  });

  // --- プレイヤー：ルーム参加 ---
  socket.on("player:joinRoom", (data, callback) => {
    const { roomId, name, secretKey } = data;
    const room = rooms[roomId];

    if (!room) {
      return callback({ ok: false, message: "そのルームは存在しません。" });
    }
    if (!name || !name.trim()) {
      return callback({ ok: false, message: "名前を入力してください。" });
    }

    let key = (secretKey || "").trim();
    if (!key) {
      key = generateSecretKey();
    }

    if (!room.players) room.players = {};

    const existed = !!room.players[key];
    const player = room.players[key] || {
      name,
      secretKey: key,
      cardNumbers: null,
    };

    player.name = name;
    player.socketId = socket.id;
    room.players[key] = player;

    socket.data.role = "player";
    socket.data.roomId = roomId;
    socket.data.secretKey = key;

    socket.join(roomId);
    emitPlayersUpdate(roomId);

    console.log(
      `player join: room=${roomId}, name=${name}, secretKey=${key}, rejoin=${existed}`
    );

    callback({
      ok: true,
      name,
      secretKey: key,
      rejoin: existed,
      cardNumbers: player.cardNumbers || null,
      room: {
        roomId,
        minNumber: room.minNumber,
        maxNumber: room.maxNumber,
        drawnNumbers: room.drawnNumbers,
      },
    });
  });

  // --- プレイヤー：カードレイアウト保存 ---
  socket.on("player:saveCard", (data, callback) => {
    const { roomId, secretKey, cardNumbers } = data;
    const room = rooms[roomId];
    if (!room || !room.players || !room.players[secretKey]) {
      if (callback) callback({ ok: false });
      return;
    }

    room.players[secretKey].cardNumbers = cardNumbers;
    console.log(`card saved: room=${roomId}, key=${secretKey}`);
    if (callback) callback({ ok: true });
  });

  // --- ホスト：数字を確定（ルーレット停止時） ---
  socket.on("host:drawNumber", (data, callback) => {
    const { roomId, number } = data;
    const room = rooms[roomId];
    if (!room) {
      if (callback) callback({ ok: false, message: "ルームが存在しません。" });
      return;
    }

    if (socket.id !== room.hostSocketId) {
      if (callback) callback({ ok: false, message: "ホストではありません。" });
      return;
    }

    const n = Number(number);
    if (!Number.isFinite(n)) {
      if (callback) callback({ ok: false, message: "数字が不正です。" });
      return;
    }

    if (!room.drawnNumbers.includes(n)) {
      room.drawnNumbers.push(n);
    }

    console.log(`number drawn: room=${roomId}, n=${n}`);

    io.to(roomId).emit("number:drawn", {
      number: n,
      drawnNumbers: room.drawnNumbers,
    });

    if (callback) callback({ ok: true });
  });

  // --- プレイヤー：ビンゴ報告 ---
  socket.on("player:bingo", (data) => {
    const { roomId, name } = data;
    const room = rooms[roomId];
    if (!room || !room.hostSocketId) return;

    io.to(room.hostSocketId).emit("player:bingo", { name });
  });

  // --- 切断 ---
  socket.on("disconnect", () => {
    const { role, roomId, secretKey } = socket.data || {};
    console.log("disconnected:", socket.id, role, roomId, secretKey);

    if (!role || !roomId) return;
    const room = rooms[roomId];
    if (!room) return;

    if (role === "host") {
      // 🔹 ルームは消さず、ホスト不在フラグだけ立てる
      room.hostSocketId = null;
      console.log(`host left temporarily: room=${roomId}`);

      // 必要ならプレイヤーへ「ホスト離脱中」の通知イベントを追加してもOK
      // io.to(roomId).emit("room:hostLeft");
    } else if (role === "player") {
      if (room.players && room.players[secretKey]) {
        room.players[secretKey].socketId = null; // 情報は残す
      }
      emitPlayersUpdate(roomId);
    }

    // 完全にルームを消したくなったら、別途「ホストが明示的に終了ボタンを押す」イベントを追加すると安全
  });
});

// const PORT = process.env.PORT || 3000;
// server.listen(PORT, () => {
//   console.log("server running on http://localhost:" + PORT);
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("listening", PORT));

// });
