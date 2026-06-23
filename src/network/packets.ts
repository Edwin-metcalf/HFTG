import { Node } from "./nodes";

//was abstract can remake abstract when different types of packets
export class Packet {
    source: Node;
    dest: Node;
    symbol: string; //ex "AAPL" a ticker or like gold or news
    price: number;//if we want to add news things as packet they might not have price

    createdAt: number;

    constructor(source: Node, dest: Node, symbol: string, price: number, createdAt: number) {
        this.source = source;
        this.dest = dest;
        this.symbol = symbol;
        this.price = price;
        this.createdAt = createdAt;
    }
}