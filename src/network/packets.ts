import { Node, type XYpoint} from "./nodes";
import { THEME } from "../theme";

//was abstract can remake abstract when different types of packets
export class Packet {
    source: Node;
    dest: Node;
    //nextHop: Node;
    symbol: string; //ex "AAPL" a ticker or like gold or news
    price: number;//price seen at the source market when this packet was created

    createdAt: number;
    expiresAt: number;

    //only a packet that has been processed at the HQ can settle a trade
    processed: boolean = false;
    //quantity of the instrument being traded
    size: number = 1;

    constructor(source: Node, dest: Node, symbol: string, price: number, createdAt: number) {
        this.source = source;
        this.dest = dest;
        //this.nextHop = nextHop;
        this.symbol = symbol;
        this.price = price;
        this.createdAt = createdAt;
        this.expiresAt = createdAt;
    }
    draw(ctx: CanvasRenderingContext2D, pos: XYpoint): void {
        const fill = this.processed ? THEME.packetProcessed : THEME.packet;
        //white halo keeps the packet readable on top of any cable colour
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 8, 0, Math.PI * 2);
        ctx.fillStyle = THEME.stationFill;
        ctx.fill();
        ctx.closePath();

        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 5.5, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.closePath();
    }
}
