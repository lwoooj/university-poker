class Dealer {
    constructor() {
        this.suits = ['♠', '♥', '♦', '♣'];
        this.values = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
        this.deck = [];
    }

    createDeck() {
        this.deck = [];
        for (let suit of this.suits) {
            for (let value of this.values) {
                this.deck.push({ suit, value });
            }
        }
        this.shuffle();
    }

    shuffle() {
        for (let i = this.deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
        }
    }

    deal(number) {
        return this.deck.splice(0, number);
    }
}

module.exports = Dealer;