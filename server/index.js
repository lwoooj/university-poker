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
    .then(() => console.log("MongoDB Connected"))
    .catch(err => console.error("MongoDB Error:", err));

const userSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    bankroll: { type: Number, default: 10000 },
    teamCode: { type: String, default: null }
});
const User = mongoose.model('User', userSchema);

const suits = ['♠', '♥', '♦', '♣'];
const values = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
let rooms = {};
let matchmakingQueue = []; // array of socket ids waiting for a match
const MATCH_SIZE = 6;

const teamSchema = new mongoose.Schema({
    name: { type: String, unique: true },
    description: String,
    code: { type: String, unique: true },
    leader: String,
    members: [String], 
    vault: { type: Number, default: 0 },
    performanceHistory: { type: Array, default: [] }
});

const Team = mongoose.model('Team', teamSchema);

const STARTING_BANKROLL = 10000;

function getGrowthPercent(bankroll = STARTING_BANKROLL) {
    return ((bankroll / STARTING_BANKROLL) - 1) * 100;
}

function toOneDecimal(value) {
    return parseFloat(value.toFixed(1));
}

const DEFAULT_GRAPH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_HISTORY_POINTS = 14;

function normalizePerformanceHistory(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return [];

    if (typeof raw[0] === 'number' && Number.isFinite(raw[0])) {
        const now = Date.now();
        const step = 5 * 60 * 1000;
        return raw.map((v, i) => ({
            at: new Date(now - (raw.length - 1 - i) * step),
            value: toOneDecimal(v)
        }));
    }

    return raw
        .map((p) => {
            if (!p || typeof p !== 'object') return null;
            const at = p.at != null ? new Date(p.at) : new Date();
            const value = toOneDecimal(Number(p.value));
            if (!Number.isFinite(value)) return null;
            return { at, value };
        })
        .filter(Boolean);
}

function historyToClient(points) {
    return points.map((p) => ({
        t: new Date(p.at).getTime(),
        v: toOneDecimal(p.value)
    }));
}

async function syncTeamPerformanceHistory(team, currentGrowth, intervalMs) {
    const growth = toOneDecimal(currentGrowth);
    const now = Date.now();

    for (let attempt = 0; attempt < 3; attempt++) {
        const fresh = attempt === 0 ? team : await Team.findById(team._id);
        if (!fresh) break;

        let points = normalizePerformanceHistory(fresh.performanceHistory);

        if (points.length === 0) {
            points.push({ at: new Date(now), value: growth });
        } else {
            const last = points[points.length - 1];
            const lastAt = new Date(last.at).getTime();
            if (now - lastAt >= intervalMs) {
                points.push({ at: new Date(now), value: growth });
            } else {
                points[points.length - 1] = { at: last.at, value: growth };
            }
        }

        while (points.length > MAX_HISTORY_POINTS) points.shift();

        const newHistory = points.map((p) => ({
            at: p.at instanceof Date ? p.at : new Date(p.at),
            value: typeof p.value === 'number' ? p.value : parseFloat(p.value)
        }));

        try {
            await Team.findByIdAndUpdate(fresh._id, { $set: { performanceHistory: newHistory } });
            return points;
        } catch (err) {
            if (attempt < 2) continue;
            throw err;
        }
    }

    return normalizePerformanceHistory(team.performanceHistory);
}

function parseGraphIntervalMs(payload) {
    if (payload && typeof payload === 'object' && payload.intervalMs != null) {
        const ms = Number(payload.intervalMs);
        if (Number.isFinite(ms) && ms > 0) return ms;
    }
    return DEFAULT_GRAPH_INTERVAL_MS;
}

function getDisplayHistoryPoints(team, avgGrowth) {
    const points = normalizePerformanceHistory(team.performanceHistory);
    const growth = toOneDecimal(avgGrowth);
    if (points.length === 0) {
        return historyToClient([{ at: new Date(), value: growth }]);
    }
    const last = points[points.length - 1];
    const copy = [...points];
    copy[copy.length - 1] = { at: last.at, value: growth };
    return historyToClient(copy);
}

async function buildTeamMetrics(team, intervalMs = DEFAULT_GRAPH_INTERVAL_MS, persistSnapshot = true) {
    const memberList = team.members || [];
    const members = await User.find({ username: { $in: memberList } });

    const memberData = members.map((m) => {
        const bankroll = m.bankroll ?? STARTING_BANKROLL;
        return {
            username: m.username,
            bankroll: Math.max(0, bankroll),
            growth: toOneDecimal(getGrowthPercent(bankroll))
        };
    });

    const totalBankroll = members.reduce((sum, m) => sum + (m.bankroll ?? STARTING_BANKROLL), 0);
    const avgGrowthRaw = members.length
        ? members.reduce((sum, m) => sum + getGrowthPercent(m.bankroll ?? STARTING_BANKROLL), 0) / members.length
        : 0;
    const avgGrowth = toOneDecimal(avgGrowthRaw);

    let historyPoints;
    if (members.length === 0) {
        historyPoints = historyToClient(normalizePerformanceHistory(team.performanceHistory));
    } else if (persistSnapshot) {
        const synced = await syncTeamPerformanceHistory(team, avgGrowth, intervalMs);
        historyPoints = historyToClient(synced);
    } else {
        historyPoints = getDisplayHistoryPoints(team, avgGrowth);
    }

    return {
        members,
        memberData,
        totalBankroll,
        avgGrowth,
        history: historyPoints
    };
}

async function getGlobalRankingsPayload(intervalMs = DEFAULT_GRAPH_INTERVAL_MS, persistSnapshots = true) {
    const teams = await Team.find({});
    const allTeamsData = await Promise.all(teams.map(async (team) => {
        const metrics = await buildTeamMetrics(team, intervalMs, persistSnapshots);
        return {
            name: team.name,
            growth: metrics.avgGrowth,
            memberCount: team.members.length,
            history: metrics.history
        };
    }));

    allTeamsData.sort((a, b) => b.growth - a.growth);
    return {
        allTeams: allTeamsData,
        topFive: allTeamsData.slice(0, 5)
    };
}

async function emitTeamAndRankingSync(teamCodes = []) {
    const uniqueTeamCodes = [...new Set((teamCodes || []).filter(Boolean))];

    await Promise.all(uniqueTeamCodes.map(async (code) => {
        const team = await Team.findOne({ code });
        if (!team) return;
        const metrics = await buildTeamMetrics(team, DEFAULT_GRAPH_INTERVAL_MS, false);
        const payload = {
            name: team.name,
            code: team.code,
            members: metrics.memberData,
            totalBankroll: metrics.totalBankroll,
            growth: metrics.avgGrowth,
            history: metrics.history
        };

        io.to(code).emit('team-details-response', payload);

        // Also send directly to connected sockets that are in this team.
        for (const clientSocket of io.sockets.sockets.values()) {
            if (clientSocket.teamCode === code) {
                clientSocket.emit('team-details-response', payload);
            }
        }
    }));

    io.emit('global-rankings-data', await getGlobalRankingsPayload(DEFAULT_GRAPH_INTERVAL_MS, false));
}

function buildLobbyListPayload() {
    return Object.keys(rooms).map(id => ({
        id,
        count: rooms[id].order.length,
        status: rooms[id].status
    }));
}

async function emitLobbySnapshotToUser(username) {
    if (!username) return;
    const user = await User.findOne({ username });
    if (!user) return;

    for (const clientSocket of io.sockets.sockets.values()) {
        if (clientSocket.username !== username) continue;

        clientSocket.bankroll = Math.max(0, user.bankroll || 0);
        clientSocket.teamCode = user.teamCode || null;
        clientSocket.emit('lobby-list', {
            bankroll: clientSocket.bankroll,
            teamCode: clientSocket.teamCode,
            list: buildLobbyListPayload()
        });

        if (clientSocket.roomId && rooms[clientSocket.roomId] && rooms[clientSocket.roomId].players[clientSocket.id]) {
            rooms[clientSocket.roomId].players[clientSocket.id].chips = clientSocket.bankroll;
            io.to(clientSocket.roomId).emit('update', rooms[clientSocket.roomId]);
        }
    }
}

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

function getHandName(score) {
    if (score >= 900) return 'ROYAL FLUSH';
    if (score >= 800) return 'STRAIGHT FLUSH';
    if (score >= 700) return 'FOUR OF A KIND';
    if (score >= 600) return 'FULL HOUSE';
    if (score >= 500) return 'FLUSH';
    if (score >= 400) return 'STRAIGHT';
    if (score >= 300) return 'THREE OF A KIND';
    if (score >= 200) return 'TWO PAIR';
    if (score >= 100) return 'ONE PAIR';
    return 'HIGH CARD';
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

    const broadcastQueueCount = () => {
        io.emit('queue-update', { count: matchmakingQueue.length, total: MATCH_SIZE });
    };

    socket.on('login', async (username) => {
        let user = await User.findOne({ username });
        if (!user) { user = new User({ username, bankroll: 10000 }); await user.save(); }
        socket.username = username;
        socket.bankroll = Math.max(0, user.bankroll || 0);
        socket.teamCode = user.teamCode;
        socket.emit('lobby-list', { 
            list: Object.keys(rooms).map(id => ({ id, count: rooms[id].order.length, status: rooms[id].status })), 
            bankroll: socket.bankroll,
            teamCode: socket.teamCode
        });
    });

    socket.on('join-queue', async () => {
        if (!socket.username) return;
        // Prevent duplicate queue entries or joining while already in a room
        if (matchmakingQueue.includes(socket.id)) return;
        if (socket.roomId && rooms[socket.roomId]) return;

        const user = await User.findOne({ username: socket.username });
        if (user) socket.bankroll = user.bankroll;

        matchmakingQueue.push(socket.id);
        broadcastQueueCount();

        // If we have enough players, start a match
        if (matchmakingQueue.length >= MATCH_SIZE) {
            const players = matchmakingQueue.splice(0, MATCH_SIZE);
            broadcastQueueCount();

            const roomId = "TABLE_" + Math.random().toString(36).substring(7).toUpperCase();
            rooms[roomId] = { id: roomId, players: {}, community: [], pot: 0, highBet: 0, order: [], turn: 0, phase: 0, status: "waiting", deck: [] };

            for (const pid of players) {
                const s = io.sockets.sockets.get(pid);
                if (s) {
                    // Refresh bankroll from DB for each player
                    const u = await User.findOne({ username: s.username });
                    if (u) s.bankroll = u.bankroll;
                    joinRoom(s, roomId);
                    s.emit('match-found', { roomId });
                }
            }
        }
    });

    socket.on('leave-queue', () => {
        matchmakingQueue = matchmakingQueue.filter(id => id !== socket.id);
        broadcastQueueCount();
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
            await emitTeamAndRankingSync([teamCode]);

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
    
    socket.on('request-global-rankings', async (payload) => {
        const intervalMs = parseGraphIntervalMs(payload);
        socket.emit('global-rankings-data', await getGlobalRankingsPayload(intervalMs));
    });

    socket.on('request-team-details', async (payload) => {
        try {
            const code = typeof payload === 'string' ? payload : payload?.code;
            const intervalMs = parseGraphIntervalMs(typeof payload === 'object' ? payload : null);
            if (!code) return;

            const team = await Team.findOne({ code });
            if (!team) return;
            const metrics = await buildTeamMetrics(team, intervalMs);

            socket.emit('team-details-response', {
                name: team.name,
                code: team.code,
                members: metrics.memberData, 
                totalBankroll: metrics.totalBankroll,
                growth: metrics.avgGrowth,
                history: metrics.history
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
        await emitTeamAndRankingSync([team.code]);

        socket.emit('lobby-list', { 
            bankroll: user.bankroll,
            teamCode: user.teamCode,
            list: Object.keys(rooms).map(id => ({ id, count: rooms[id].order.length }))
        });
    });

    socket.on('quit-team', async () => {
        const user = await User.findOne({ username: socket.username });
        if (!user || !user.teamCode) return;
        const previousTeamCode = user.teamCode;

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

        await emitTeamAndRankingSync([previousTeamCode]);

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

    socket.on('team-transfer-bankroll', async (payload) => {
        try {
            const toUsername = payload && typeof payload.toUsername === 'string' ? payload.toUsername.trim() : '';
            const amount = Math.floor(Number(payload && payload.amount));

            if (!socket.username) return socket.emit('error-msg', 'Login required.');
            if (!toUsername) return socket.emit('error-msg', 'Invalid recipient.');
            if (toUsername === socket.username) return socket.emit('error-msg', 'You cannot transfer to yourself.');
            if (!Number.isFinite(amount) || amount <= 0) return socket.emit('error-msg', 'Enter a valid transfer amount.');

            const [sender, recipient] = await Promise.all([
                User.findOne({ username: socket.username }),
                User.findOne({ username: toUsername })
            ]);

            if (!sender || !recipient) return socket.emit('error-msg', 'Player not found.');
            if (!sender.teamCode || sender.teamCode !== recipient.teamCode) {
                return socket.emit('error-msg', 'Transfer allowed only between teammates.');
            }

            const team = await Team.findOne({ code: sender.teamCode });
            if (!team) return socket.emit('error-msg', 'Team not found.');
            if (!team.members.includes(sender.username) || !team.members.includes(recipient.username)) {
                return socket.emit('error-msg', 'Both players must be active team members.');
            }

            if ((recipient.bankroll || 0) > 0) {
                return socket.emit('error-msg', 'This rescue transfer is only for BROKE teammates.');
            }
            if ((sender.bankroll || 0) < amount) {
                return socket.emit('error-msg', 'Insufficient bankroll for this transfer.');
            }

            sender.bankroll = Math.max(0, (sender.bankroll || 0) - amount);
            recipient.bankroll = Math.max(0, (recipient.bankroll || 0) + amount);
            await Promise.all([sender.save(), recipient.save()]);

            await Promise.all([
                emitTeamAndRankingSync([sender.teamCode]),
                emitLobbySnapshotToUser(sender.username),
                emitLobbySnapshotToUser(recipient.username)
            ]);

            io.to(`chat_${sender.teamCode}`).emit('receive-team-message', {
                sender: 'SYSTEM',
                text: `${sender.username} sent $${amount.toLocaleString()} to ${recipient.username}.`,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });

            const transferNotice = {
                teamCode: sender.teamCode,
                from: sender.username,
                to: recipient.username,
                amount
            };
            for (const clientSocket of io.sockets.sockets.values()) {
                if (clientSocket.teamCode === sender.teamCode) {
                    clientSocket.emit('team-transfer-success', transferNotice);
                }
            }
        } catch (err) {
            console.error('Team Transfer Error:', err);
            socket.emit('error-msg', 'Transfer failed. Please try again.');
        }
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

                const antePaid = Math.min(ante, Math.max(0, p.chips));
                p.chips = Math.max(0, p.chips - antePaid);
                room.pot += antePaid;
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
            if (diff < 0 || diff > p.chips) {
                return socket.emit('error-msg', "Not enough chips to call.");
            }
            p.chips -= diff; p.bet += diff; room.pot += diff; p.last = `CALL $${diff}`;
        }
        else if (data.type === 'raise') {
            const amt = parseInt(data.amount);
            if (isNaN(amt) || amt <= room.highBet) return socket.emit('error-msg', "Raise must be higher than current bet!");
            const added = amt - p.bet;
            if (added <= 0 || added > p.chips) {
                return socket.emit('error-msg', "Raise amount exceeds your chips.");
            }
            p.chips -= added; p.bet = amt; room.pot += added;
            room.highBet = amt; p.last = `RAISE $${amt}`;
            room.order.forEach(pid => { if (pid !== socket.id) room.players[pid].acted = false; });
        }
        else if (data.type === 'all-in') {
            if (room.highBet > p.bet) {
                return socket.emit('error-msg', "All in unavailable: respond with call or fold.");
            }
            const activePlayers = room.order
                .filter(id => !room.players[id].folded)
                .map(id => room.players[id]);
            const minStack = activePlayers.length
                ? Math.min(...activePlayers.map(player => player.chips + player.bet))
                : 0;
            const targetBet = Math.max(room.highBet, minStack);
            const added = targetBet - p.bet;
            if (added <= 0 || added > p.chips) {
                return socket.emit('error-msg', "All in amount is invalid.");
            }
            p.chips -= added;
            p.bet = targetBet;
            room.pot += added;
            room.highBet = targetBet;
            p.last = `ALL IN $${targetBet}`;
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

    async function resolveWinner(room, winnerId, reason, scores = {}) {
        const winner = room.players[winnerId];
        winner.chips += room.pot;

        const teamCodesToSync = new Set();
        for (const playerId of room.order) {
            const player = room.players[playerId];
            if (!player) continue;
            const updatedUser = await User.findOneAndUpdate(
                { username: player.username },
                { bankroll: Math.max(0, player.chips) },
                { returnDocument: 'after' }
            );
            if (updatedUser && updatedUser.teamCode) teamCodesToSync.add(updatedUser.teamCode);
        }

        if (teamCodesToSync.size > 0) {
            await emitTeamAndRankingSync([...teamCodesToSync]);
        }

        const foldWin = reason === 'Folds';
        const winnerHand = !foldWin && scores[winnerId] != null ? getHandName(scores[winnerId]) : null;

        // Emit individually so each player receives their own hand name
        room.order.forEach(pid => {
            const s = io.sockets.sockets.get(pid);
            if (s) {
                const myHand = !foldWin && scores[pid] != null ? getHandName(scores[pid]) : null;
                s.emit('done', {
                    win: winnerId,
                    amount: room.pot,
                    msg: reason,
                    myHand,
                    winnerHand,
                    winnerUsername: winner.username,
                });
            }
        });

        room.status = "waiting";
        room.pot = 0;
        io.to(socket.roomId).emit('update', room);
    }

    async function showdown(room) {
        const active = room.order.filter(id => !room.players[id].folded);
        let bestId = active[0], bestScore = -1;
        const scores = {};
        active.forEach(id => {
            const score = getHandScore(room.players[id].cards, room.community);
            scores[id] = score;
            if (score > bestScore) { bestScore = score; bestId = id; }
        });
        await resolveWinner(room, bestId, "Showdown", scores);
    }

    socket.on('leave-room', async () => {
        const roomId = socket.roomId;
        if (rooms[roomId]) {
            const p = rooms[roomId].players[socket.id];
            
            if (p) {
                const updatedUser = await User.findOneAndUpdate(
                    { username: p.username }, 
                    { bankroll: Math.max(0, p.chips) },
                    { returnDocument: 'after' } 
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

            socket.leave(roomId);
            socket.roomId = null; 

            if (rooms[roomId].order.length === 0) {
                delete rooms[roomId];
                broadcastLobbyList();
            } else {
                io.to(roomId).emit('update', rooms[roomId]);
            }

            socket.emit('back-to-lobby');
        }
    });

    socket.on('disconnect', () => {
        if (matchmakingQueue.includes(socket.id)) {
            matchmakingQueue = matchmakingQueue.filter(id => id !== socket.id);
            broadcastQueueCount();
        }
    });
});

server.listen(process.env.PORT || 3000, () => console.log("Server Running"));