const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '..', 'client')));

// --- 1. DATABASE CONFIGURATION ---
// Connect to your MongoDB (Local or Atlas)
const MONGO_URI = process.env.MONGO_URI;
mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ MongoDB Connected Successfully"))
    .catch(err => console.error("❌ MongoDB Connection Error:", err));

const userSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    bankroll: { type: Number, default: 10000 }
});
const User = mongoose.model('User', userSchema);

// --- 2. GAME CONSTANTS & HELPERS ---
const suits = ['♠', '♥', '♦', '♣'];
const values = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
let rooms = {};

function createDeck() {
    let deck = [];
    for (let s of suits) for (let v of values) deck.push({ suit: s, value: v });
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function getHandScore(hand, community) {
    const fullHand = [...hand, ...community];
    const vCounts = {};
    const sCounts = {};
    fullHand.forEach(c => {
        vCounts[c.value] = (vCounts[c.value] || 0) + 1;
        sCounts[c.suit] = (sCounts[c.suit] || 0) + 1;
    });

    const vSorted = Object.keys(vCounts).map(Number).sort((a, b) => b - a);
    const isFlush = Object.values(sCounts).some(count => count >= 5);
    
    let isStraight = false;
    let straightHigh = 0;
    for (let i = 0; i <= vSorted.length - 5; i++) {
        if (vSorted[i] - vSorted[i+4] === 4) { isStraight = true; straightHigh = vSorted[i]; break; }
    }

    const pairs = Object.entries(vCounts).filter(([v, c]) => c === 2).map(([v]) => Number(v)).sort((a,b)=>b-a);
    const trips = Object.entries(vCounts).filter(([v, c]) => c === 3).map(([v]) => Number(v));
    const quads = Object.entries(vCounts).filter(([v, c]) => c === 4).map(([v]) => Number(v));

    if (isFlush && isStraight) return 800 + straightHigh;
    if (quads.length) return 700 + quads[0];
    if (trips.length && pairs.length) return 600 + trips[0];
    if (isFlush) return 500 + vSorted[0];
    if (isStraight) return 400 + straightHigh;
    if (trips.length) return 300 + trips[0];
    if (pairs.length >= 2) return 200 + pairs[0];
    if (pairs.length === 1) return 100 + pairs[0];
    return vSorted[0];
}

// --- 3. SOCKET SERVER LOGIC ---
io.on('connection', (socket) => {
    
    // Auth: Load or Create User from DB
    socket.on('login', async (username) => {
        let user = await User.findOne({ username });
        if (!user) {
            user = new User({ username, bankroll: 10000 });
            await user.save();
        }
        socket.username = username;
        socket.bankroll = user.bankroll;
        
        socket.emit('lobby-list', { 
            list: Object.keys(rooms).map(id => ({ id, count: rooms[id].order.length, status: rooms[id].status })), 
            bankroll: socket.bankroll 
        });
    });

    socket.on('create-room', () => {
        if (!socket.username) return;
        const roomId = "TABLE_" + Math.random().toString(36).substring(7).toUpperCase();
        rooms[roomId] = {
            players: {}, community: [], pot: 0, highBet: 0, order: [], turn: 0, phase: 0, status: "waiting", deck: []
        };
        joinRoom(socket, roomId);
    });

    socket.on('join-room', (roomId) => {
        const room = rooms[roomId];
        if (room && room.order.length < 6 && room.status === "waiting") {
            joinRoom(socket, roomId);
        }
    });

    function joinRoom(socket, roomId) {
        socket.join(roomId);
        socket.roomId = roomId;
        rooms[roomId].players[socket.id] = { 
            username: socket.username,
            cards: [], chips: socket.bankroll, bet: 0, folded: false, acted: false, last: "JOINED" 
        };
        rooms[roomId].order.push(socket.id);
        io.to(roomId).emit('update', rooms[roomId]);
    }

    socket.on('start-game', async () => {
        const room = rooms[socket.roomId];
        if (!room || room.order.length < 2) return;

        // Apply $100 Ante
        const ante = 100;
        let canStart = true;
        room.order.forEach(id => { if (room.players[id].chips < ante) canStart = false; });

        if (!canStart) return io.to(socket.roomId).emit('error-msg', "Someone cannot afford the $100 Ante!");

        room.pot = 0;
        for (let id of room.order) {
            room.players[id].chips -= ante;
            room.pot += ante;
            // Update MongoDB for every player's ante deduction
            await User.findOneAndUpdate({ username: room.players[id].username }, { bankroll: room.players[id].chips });
        }

        room.status = "playing";
        room.deck = createDeck();
        room.highBet = 0; room.turn = 0; room.phase = 0; room.community = [];
        room.order.forEach(id => {
            const p = room.players[id];
            p.folded = false; p.bet = 0; p.acted = false; p.last = "ANTE $100";
            p.cards = [room.deck.pop(), room.deck.pop()];
            io.to(id).emit('receive-cards', p.cards);
        });
        io.to(socket.roomId).emit('update', room);
    });

    socket.on('action', (data) => {
        const room = rooms[socket.roomId];
        if (!room || room.order[room.turn] !== socket.id) return;
        const p = room.players[socket.id];
        p.acted = true;

        if (data.type === 'fold') { p.folded = true; p.last = "FOLDED"; }
        else if (data.type === 'check') { p.last = "CHECKED"; }
        else if (data.type === 'call') {
            const diff = room.highBet - p.bet;
            p.chips -= diff; p.bet += diff; room.pot += diff; p.last = `CALLED $${diff}`;
        }
        else if (data.type === 'raise') {
            const amt = parseInt(data.amount);
            const added = amt - p.bet;
            p.chips -= added; p.bet = amt; room.pot += added;
            room.highBet = amt; p.last = `RAISED TO $${amt}`;
            room.order.forEach(pid => { if (pid !== socket.id) room.players[pid].acted = false; });
        }
        processNext(room);
    });

    function processNext(room) {
        const active = room.order.filter(id => !room.players[id].folded);
        if (active.length === 1) return resolveWinner(room, active[0], "Everyone folded");
        
        const done = active.every(id => room.players[id].acted && room.players[id].bet === room.highBet);
        if (done) {
            room.phase++;
            room.highBet = 0;
            room.order.forEach(id => { room.players[id].bet = 0; room.players[id].acted = false; room.players[id].last = ""; });
            if (room.phase === 1) room.community = [room.deck.pop(), room.deck.pop(), room.deck.pop()];
            else if (room.phase === 2 || room.phase === 3) room.community.push(room.deck.pop());
            else if (room.phase === 4) return showdown(room);
            room.turn = 0;
            while (room.players[room.order[room.turn]].folded) room.turn = (room.turn + 1) % room.order.length;
        } else {
            room.turn = (room.turn + 1) % room.order.length;
            while (room.players[room.order[room.turn]].folded) room.turn = (room.turn + 1) % room.order.length;
        }
        io.to(socket.roomId).emit('update', room);
    }

    async function resolveWinner(room, winnerId, reason) {
        const winner = room.players[winnerId];
        winner.chips += room.pot;
        
        // Final Sync to MongoDB
        await User.findOneAndUpdate({ username: winner.username }, { bankroll: winner.chips });

        io.to(socket.roomId).emit('done', { win: winnerId, amount: room.pot, msg: reason });
        room.status = "waiting";
        room.pot = 0;
        io.to(socket.roomId).emit('update', room);
    }

    async function showdown(room) {
        const active = room.order.filter(id => !room.players[id].folded);
        let bestId = active[0], bestScore = -1;
        active.forEach(id => {
            const score = getHandScore(room.players[id].cards, room.community);
            if (score > bestScore) { bestScore = score; bestId = id; }
        });
        await resolveWinner(room, bestId, "Showdown Winner");
    }

    socket.on('leave-room', async () => {
        const roomId = socket.roomId;
        if (rooms[roomId]) {
            const p = rooms[roomId].players[socket.id];
            if (p) await User.findOneAndUpdate({ username: p.username }, { bankroll: p.chips });
            
            delete rooms[roomId].players[socket.id];
            rooms[roomId].order = rooms[roomId].order.filter(id => id !== socket.id);
            socket.leave(roomId);
            socket.roomId = null;

            if (rooms[roomId].order.length === 0) delete rooms[roomId];
            else io.to(roomId).emit('update', rooms[roomId]);
            
            const user = await User.findOne({ username: socket.username });
            socket.emit('back-to-lobby', { bankroll: user.bankroll });
        }
    });

    socket.on('disconnect', async () => {
        if (socket.roomId && rooms[socket.roomId]) {
            const p = rooms[socket.roomId].players[socket.id];
            if (p) await User.findOneAndUpdate({ username: p.username }, { bankroll: p.chips });
            delete rooms[socket.roomId].players[socket.id];
            rooms[socket.roomId].order = rooms[socket.roomId].order.filter(id => id !== socket.id);
            if (rooms[socket.roomId].order.length === 0) delete rooms[socket.roomId];
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));