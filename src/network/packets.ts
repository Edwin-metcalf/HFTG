import { Node, type XYpoint} from "./nodes";

//was abstract can remake abstract when different types of packets
export class Packet {
    source: Node;
    dest: Node;
    //nextHop: Node;
    symbol: string; //ex "AAPL" a ticker or like gold or news
    price: number;//if we want to add news things as packet they might not have price

    createdAt: number;

    constructor(source: Node, dest: Node, symbol: string, price: number, createdAt: number) {
        this.source = source;
        this.dest = dest;
        //this.nextHop = nextHop;
        this.symbol = symbol;
        this.price = price;
        this.createdAt = createdAt;
    }
    draw(ctx: CanvasRenderingContext2D, pos: XYpoint): void {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = '#555555';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.closePath();
    }
}