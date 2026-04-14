const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(path.join(__dirname, '..', 'client')));

const MONGO_URI = process.env.MONGO_URI;
mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.error("❌ MongoDB Error:", err));

const userSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    bankroll: { type: Number, default: 10000 },
    teamCode: { type: String, default: null }
});
const User = mongoose.model('User', userSchema);

const suits = ['♠', '♥', '♦', '♣'];
const values = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
let rooms = {};

const teamSchema = new mongoose.Schema({
    name: { type: String, unique: true },
    description: String,
    code: { type: String, unique: true },
    leader: String,
    members: [String], 
    vault: { type: Number, default: 0 },
    performanceHistory: { type: [Number], default: [0] }
});

const Team = mongoose.model('Team', teamSchema);

async function takeTeamSnapshots() {
    const teams = await Team.find({});
    for (let team of teams) {
        const members = await User.find({ username: { $in: team.members } });
        if (members.length === 0) continue;

        let totalPercent = 0;
        members.forEach(m => {
            const memberGrowth = ((m.bankroll / 10000) - 1) * 100;
            totalPercent += memberGrowth;
        });

        const avgPercent = totalPercent / members.length;

        team.performanceHistory.push(parseFloat(avgPercent.toFixed(2)));
        if (team.performanceHistory.length > 14) team.performanceHistory.shift();
        
        await team.save();
    }
    console.log("✅ 12-Hour Team Snapshots Updated");
}

setInterval(takeTeamSnapshots, 43200000);

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
    const fullHand = [...hand, ...community].sort((a, b) => b.value - a.value);

    // --- HELPER: Tie-Breaker Calculation ---
    // Standardizes how we add kickers to base scores using decimals
    const getKickerScore = (excludeVals, countNeeded) => {
        const kickers = fullHand.filter(c => !excludeVals.includes(c.value)).slice(0, countNeeded);
        return kickers.reduce((acc, card, index) => acc + (card.value / Math.pow(100, index + 1)), 0);
    };

    // 1. Check for FLUSH (Needed for Straight Flush & Flush)
    const suitCounts = {};
    fullHand.forEach(c => suitCounts[c.suit] = (suitCounts[c.suit] || 0) + 1);
    const flushSuit = Object.keys(suitCounts).find(s => suitCounts[s] >= 5);
    const flushCards = flushSuit ? fullHand.filter(c => c.suit === flushSuit) : null;

    // 2. ROYAL / STRAIGHT FLUSH
    if (flushCards) {
        const sVals = [...new Set(flushCards.map(c => c.value))];
        for (let i = 0; i <= sVals.length - 5; i++) {
            if (sVals[i] - sVals[i + 4] === 4) {
                return (sVals[i] === 14 ? 900 : 800) + sVals[i];
            }
        }
        // A-2-3-4-5 Straight Flush (The Wheel)
        if ([14, 5, 4, 3, 2].every(v => sVals.includes(v))) return 805; 
    }

    // 3. Frequency Analysis (Group cards by how many of each rank)
    const vCounts = {};
    fullHand.forEach(c => vCounts[c.value] = (vCounts[c.value] || 0) + 1);
    const counts = Object.entries(vCounts)
        .map(([val, count]) => ({ val: Number(val), count }))
        // CRITICAL: Sort by frequency first, then by card value
        .sort((a, b) => b.count - a.count || b.val - a.val);

    // 4. FOUR OF A KIND
    if (counts[0].count === 4) {
        return 700 + counts[0].val + getKickerScore([counts[0].val], 1);
    }

    // 5. FULL HOUSE 
    // If you have two sets of Trips, the higher Trip is the set, the lower Trip is the pair.
    if (counts[0].count === 3 && counts[1] && counts[1].count >= 2) {
        return 600 + counts[0].val + (counts[1].val / 100);
    }

    // 6. FLUSH
    if (flushCards) {
        return 500 + flushCards.slice(0, 5).reduce((acc, c, i) => acc + (c.value / Math.pow(100, i)), 0);
    }

    // 7. STRAIGHT
    const uniqueVals = [...new Set(fullHand.map(c => c.value))];
    for (let i = 0; i <= uniqueVals.length - 5; i++) {
        if (uniqueVals[i] - uniqueVals[i + 4] === 4) return 400 + uniqueVals[i];
    }
    if ([14, 5, 4, 3, 2].every(v => uniqueVals.includes(v))) return 405;

    // 8. THREE OF A KIND
    if (counts[0].count === 3) {
        return 300 + counts[0].val + getKickerScore([counts[0].val], 2);
    }

    // 9. TWO PAIR (The "Friend Fix")
    // Filter all pairs. If there are 3 pairs, this picks the top 2.
    const allPairs = counts.filter(c => c.count >= 2);
    if (allPairs.length >= 2) {
        return 200 + allPairs[0].val + (allPairs[1].val / 100) + getKickerScore([allPairs[0].val, allPairs[1].val], 1);
    }

    // 10. ONE PAIR
    if (counts[0].count === 2) {
        return 100 + counts[0].val + getKickerScore([counts[0].val], 3);
    }

    // 11. HIGH CARD
    return fullHand.slice(0, 5).reduce((acc, c, i) => acc + (c.value / Math.pow(100, i)), 0);
}

io.on('connection', (socket) => {
    const broadcastLobbyList = () => {
        const roomData = Object.keys(rooms).map(id => ({ 
            id, 
            count: rooms[id].order.length, 
            status: rooms[id].status 
        }));
        io.emit('lobby-list-update', { list: roomData });
    };

    socket.on('login', async (username) => {
        let user = await User.findOne({ username });
        if (!user) { user = new User({ username, bankroll: 10000 }); await user.save(); }
        socket.username = username;
        socket.bankroll = user.bankroll;
        socket.teamCode = user.teamCode;
        socket.emit('lobby-list', { 
            list: Object.keys(rooms).map(id => ({ id, count: rooms[id].order.length, status: rooms[id].status })), 
            bankroll: socket.bankroll,
            teamCode: socket.teamCode
        });
    });

    socket.on('create-room', async () => {
        if (!socket.username) return;
        const user = await User.findOne({ username: socket.username });
        if (user) {
            socket.bankroll = user.bankroll;
            const roomId = "TABLE_" + Math.random().toString(36).substring(7).toUpperCase();
            rooms[roomId] = { players: {}, community: [], pot: 0, highBet: 0, order: [], turn: 0, phase: 0, status: "waiting", deck: [] };
            joinRoom(socket, roomId);
        }
        broadcastLobbyList();
    });

    socket.on('join-room', async (roomId) => {
        const room = rooms[roomId];
        if (room && room.order.length < 6 && room.status === "waiting") { 
            const user = await User.findOne({ username: socket.username });
            if (user) {
                socket.bankroll = user.bankroll;
                joinRoom(socket, roomId);
            }
        }
    });

    socket.on('request-create-team', async (data) => {
        const user = await User.findOne({ username: socket.username });

        // Generate unique 6-character code
        const teamCode = Math.random().toString(36).substring(2, 8).toUpperCase();

        try {
            const newTeam = new Team({
                name: data.name,
                description: data.desc,
                code: teamCode,
                leader: socket.username,
                members: [socket.username]
            });

            await newTeam.save();

            user.teamCode = teamCode;
            await user.save();
            socket.teamCode = teamCode;

            socket.emit('team-created', { name: data.name, code: teamCode });
            
            // Update their lobby stats immediately
            socket.emit('lobby-list', { 
                bankroll: user.bankroll,
                teamCode: socket.teamCode,
                list: Object.keys(rooms).map(id => ({ id, count: rooms[id].order.length }))
            });

        } catch (err) {
            socket.emit('error-msg', "Team name already exists!");
        }
    });
    
    socket.on('request-global-rankings', async () => {
        const teams = await Team.find({});
        
        // Process all teams for the list
        const allTeamsData = await Promise.all(teams.map(async (t) => {
            const members = await User.find({ username: { $in: t.members } });
            let totalPercent = 0;
            members.forEach(m => totalPercent += (((m.bankroll / 10000) - 1) * 100));
            const avgGrowth = members.length > 0 ? (totalPercent / members.length) : 0;

            return {
                name: t.name,
                growth: parseFloat(avgGrowth.toFixed(1)),
                memberCount: t.members.length,
                history: t.performanceHistory
            };
        }));

        // Sort by growth descending
        allTeamsData.sort((a, b) => b.growth - a.growth);

        // Take top 5 for the chart
        const topFive = allTeamsData.slice(0, 5);

        socket.emit('global-rankings-data', {
            allTeams: allTeamsData,
            topFive: topFive
        });
    });

    socket.on('request-team-details', async (code) => {
        try {
            const team = await Team.findOne({ code });
            if (!team) return;

            const memberList = team.members || [];
            const members = await User.find({ username: { $in: memberList } });

            const memberData = members.map(m => {
                const bankroll = m.bankroll || 10000;
                const growth = (((bankroll / 10000) - 1) * 100).toFixed(1);
                return {
                    username: m.username,
                    growth: growth
                };
            });
        
            const totalBankroll = members.reduce((sum, m) => sum + (m.bankroll || 10000), 0);

            let avgGrowth = 0;
            if (members.length > 0) {
                let totalPercent = 0;
                members.forEach(m => {
                    totalPercent += ((( (m.bankroll || 10000) / 10000) - 1) * 100);
                });
                avgGrowth = parseFloat((totalPercent / members.length).toFixed(1));
            }

            const performanceHistory = team.performanceHistory && team.performanceHistory.length > 0 
                ? team.performanceHistory 
                : [0];

            socket.emit('team-details-response', {
                name: team.name,
                code: team.code,
                members: memberData, 
                totalBankroll: totalBankroll,
                growth: avgGrowth,
                history: performanceHistory
            });
        } catch (err) {
            console.error("Team Details Error:", err);
        }
    });

    socket.on('request-all-teams', async () => {
        const teams = await Team.find({});
        const formattedTeams = teams.map(t => ({
            name: t.name,
            code: t.code,
            memberCount: t.members.length
        }));
        socket.emit('all-teams-list', formattedTeams);
    });

    socket.on('request-join-team', async (code) => {
        const team = await Team.findOne({ code: code.toUpperCase() });
        const user = await User.findOne({ username: socket.username });

        if (!team) return socket.emit('error-msg', "Invalid Team Code.");
        if (user.teamCode) return socket.emit('error-msg', "You are already in a team.");
        if (team.members.length >= 10) return socket.emit('error-msg', "Team is full.");

        team.members.push(socket.username);
        await team.save();

        user.teamCode = team.code;
        await user.save();
        
        socket.join(team.code); 
        socket.teamCode = team.code;

        socket.emit('team-joined', { name: team.name, code: team.code });

        const members = await User.find({ username: { $in: team.members } });
        const memberData = members.map(m => ({
            username: m.username,
            growth: (((m.bankroll / 10000) - 1) * 100).toFixed(1)
        }));
        
        const totalBankroll = members.reduce((sum, m) => sum + m.bankroll, 0);
        let totalPercent = 0;
        members.forEach(m => totalPercent += (((m.bankroll / 10000) - 1) * 100));
        const avgGrowth = members.length ? (totalPercent / members.length).toFixed(1) : '0.0';

        io.to(team.code).emit('team-details-response', {
            name: team.name,
            code: team.code,
            members: memberData,
            totalBankroll,
            growth: avgGrowth,
            history: team.performanceHistory || [0]
        });

        socket.emit('lobby-list', { 
            bankroll: user.bankroll,
            teamCode: user.teamCode,
            list: Object.keys(rooms).map(id => ({ id, count: rooms[id].order.length }))
        });
    });

    socket.on('quit-team', async () => {
        const user = await User.findOne({ username: socket.username });
        if (!user || !user.teamCode) return;

        const team = await Team.findOne({ code: user.teamCode });
        user.teamCode = null;
        await user.save();
        socket.teamCode = null;

        if (team) {
            team.members = team.members.filter((member) => member !== socket.username);
            if (team.members.length === 0) {
                await Team.deleteOne({ code: team.code });
            } else {
                if (team.leader === socket.username) {
                    team.leader = team.members[0];
                }
                await team.save();
            }
        }

        socket.emit('team-left');
        socket.emit('lobby-list', {
            bankroll: user.bankroll,
            teamCode: null,
            list: Object.keys(rooms).map(id => ({ id, count: rooms[id].order.length }))
        });
    });

    socket.on('join-team-chat', (teamCode) => {
            if (!teamCode) return;
            socket.join(`chat_${teamCode}`);
            console.log(`${socket.username} joined chat for ${teamCode}`);
        });

        socket.on('send-team-message', (data) => {
            if (!data.message || !data.teamCode) return;

            const chatPayload = {
                sender: socket.username,
                text: data.message,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };

            io.to(`chat_${data.teamCode}`).emit('receive-team-message', chatPayload);
        });

    function joinRoom(socket, roomId) {
        socket.join(roomId);
        socket.roomId = roomId;
        rooms[roomId].players[socket.id] = { username: socket.username, cards: [], chips: socket.bankroll, bet: 0, folded: false, acted: false, last: "JOINED" };
        rooms[roomId].order.push(socket.id);
        io.to(roomId).emit('update', rooms[roomId]);
    }

    socket.on('start-game', async () => {
            const room = rooms[socket.roomId];
            if (!room || room.order.length < 2) return;
            const ante = 100;
            for (let id of room.order) {
                const p = room.players[id];
                p.startChips = p.chips; 
                
                p.chips -= ante;
                room.pot += ante;
                await User.findOneAndUpdate({ username: p.username }, { bankroll: p.chips });
            }
            room.status = "playing";
            room.deck = createDeck();
            room.highBet = 0; room.turn = 0; room.phase = 0; room.community = [];
            room.order.forEach(id => {
                const p = room.players[id];
                p.cards = [room.deck.pop(), room.deck.pop()];
                p.folded = false; p.acted = false; p.bet = 0;
                io.to(id).emit('receive-cards', p.cards);
            });
            io.to(socket.roomId).emit('update', room);
    });

    socket.on('action', (data) => {
        const room = rooms[socket.roomId];
        if (!room || room.order[room.turn] !== socket.id) return;
        const p = room.players[socket.id];

        if (data.type === 'check' && room.highBet > p.bet) {
            return socket.emit('error-msg', "Illegal move: You must call or fold.");
        }

        p.acted = true;
        if (data.type === 'fold') { p.folded = true; p.last = "FOLD"; }
        else if (data.type === 'check') { p.last = "CHECK"; }
        else if (data.type === 'call') {
            const diff = room.highBet - p.bet;
            p.chips -= diff; p.bet += diff; room.pot += diff; p.last = `CALL $${diff}`;
        }
        else if (data.type === 'raise') {
            const amt = parseInt(data.amount);
            if (isNaN(amt) || amt <= room.highBet) return socket.emit('error-msg', "Raise must be higher than current bet!");
            const added = amt - p.bet;
            p.chips -= added; p.bet = amt; room.pot += added;
            room.highBet = amt; p.last = `RAISE $${amt}`;
            room.order.forEach(pid => { if (pid !== socket.id) room.players[pid].acted = false; });
        }
        processNext(room);
    });

    function processNext(room) {
        const active = room.order.filter(id => !room.players[id].folded);
        if (active.length === 1) return resolveWinner(room, active[0], "Folds");
        const done = active.every(id => room.players[id].acted && room.players[id].bet === room.highBet);
        if (done) {
            room.phase++;
            room.highBet = 0;
            room.order.forEach(id => { room.players[id].bet = 0; room.players[id].acted = false; });
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
        await resolveWinner(room, bestId, "Showdown");
    }

    socket.on('leave-room', async () => {
        const roomId = socket.roomId;
        if (rooms[roomId]) {
            const p = rooms[roomId].players[socket.id];
            
            if (p) {
                const updatedUser = await User.findOneAndUpdate(
                    { username: p.username }, 
                    { bankroll: p.chips },
                    { new: true } 
                );

                socket.emit('lobby-list', {
                    bankroll: updatedUser.bankroll,
                    teamCode: updatedUser.teamCode,
                    list: Object.values(rooms).map(r => ({
                        id: r.id,
                        count: r.order.length
                    }))
                });
            }

            rooms[roomId].order = rooms[roomId].order.filter(id => id !== socket.id);
            delete rooms[roomId].players[socket.id];

            if (rooms[roomId].order.length === 0) {
                delete rooms[roomId];
                broadcastLobbyList();
            } else {
                io.to(roomId).emit('update', rooms[roomId]);
            }
            socket.emit('back-to-lobby');
        }
    });
});

server.listen(process.env.PORT || 3000, () => console.log("Server Running"));