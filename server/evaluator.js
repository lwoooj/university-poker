function evaluateHand(cards) {
    const sorted = [...cards].sort((a, b) => b.value - a.value);
    const rankCounts = {};
    const suitCounts = {};
    
    sorted.forEach(c => {
        rankCounts[c.value] = (rankCounts[c.value] || 0) + 1;
        suitCounts[c.suit] = (suitCounts[c.suit] || 0) + 1;
    });

    const counts = Object.values(rankCounts);
    const hasFlush = Object.values(suitCounts).some(count => count >= 5);
    const isStraight = checkStraight(sorted);

    if (hasFlush && isStraight) return { score: 9, name: "Straight Flush" };
    if (counts.includes(4)) return { score: 8, name: "Four of a Kind" };
    if (counts.includes(3) && counts.includes(2)) return { score: 7, name: "Full House" };
    if (hasFlush) return { score: 6, name: "Flush" };
    if (isStraight) return { score: 5, name: "Straight" };
    if (counts.includes(3)) return { score: 4, name: "Three of a Kind" };
    if (counts.filter(c => c === 2).length >= 2) return { score: 3, name: "Two Pair" };
    if (counts.includes(2)) return { score: 2, name: "One Pair" };
    return { score: 1, name: "High Card" };
}

function checkStraight(cards) {
    const values = [...new Set(cards.map(c => c.value))].sort((a,b) => b-a);
    let count = 1;
    for(let i=0; i<values.length-1; i++) {
        if(values[i] - values[i+1] === 1) count++;
        else count = 1;
        if(count === 5) return true;
    }
    return false;
}

module.exports = { evaluateHand };