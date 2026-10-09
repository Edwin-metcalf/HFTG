import { Node, type XYpoint } from "./nodes";
import type { Packet } from "./packets";
import { LINE, LINE_COLORS } from "../theme";

let lineColorCursor = 0;

//cables cost a fixed connection fee plus a per-distance run of fibre
export function cableCost(a: XYpoint, b: XYpoint): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    return 50 + Math.round(length / 8);
}

//this was also abstract but isnt now and can be later with unique link types
//a link is an undirected cable: packets can travel either way along it
export class Link {
    a: Node;
    b: Node;

    //latency is how long a packet takes to travel the whole cable, in seconds
    latency: number;
    //how many concurrent orders the user can do
    bandwidth: number;
    cost: number;
    length: number;
    color: string;
    //line upgrade level: higher levels move packets faster along the cable
    speed: number = 1;
    ctx: CanvasRenderingContext2D;

    packetsInTransit: { packet: Packet, from: Node, to: Node, progress: number }[] = [];

    constructor(a: Node, b: Node, ctx: CanvasRenderingContext2D){
        this.a = a;
        this.b = b;

        const dx = b.position.x - a.position.x;
        const dy = b.position.y - a.position.y;
        this.length = Math.sqrt(dx * dx + dy * dy);

        //longer cables are slower to traverse; line upgrades divide this down
        this.latency = Math.max(1.1, this.length / 360);
        this.bandwidth = 5;
        this.cost = cableCost(a.position, b.position);
        this.color = LINE_COLORS[lineColorCursor % LINE_COLORS.length];
        lineColorCursor++;
        this.ctx = ctx;
    }

    //the node on the other end of the cable
    other(node: Node): Node | null {
        if (node === this.a) return this.b;
        if (node === this.b) return this.a;
        return null;
    }

    connects(x: Node, y: Node): boolean {
        return (this.a === x && this.b === y) || (this.a === y && this.b === x);
    }

    //gives the cable a gentle bow so it reads as a smooth curve
    private controlPoint(): XYpoint {
        const { a, b } = this;
        const dx = b.position.x - a.position.x;
        const dy = b.position.y - a.position.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const bend = Math.min(dist * 0.12, 60);
        return {
            x: (a.position.x + b.position.x) / 2 - (dy / dist) * bend,
            y: (a.position.y + b.position.y) / 2 + (dx / dist) * bend,
        };
    }

    private pointAt(t: number, control: XYpoint): XYpoint {
        const p0 = this.a.position;
        const p2 = this.b.position;
        const mt = 1 - t;
        return {
            x: mt * mt * p0.x + 2 * mt * t * control.x + t * t * p2.x,
            y: mt * mt * p0.y + 2 * mt * t * control.y + t * t * p2.y,
        };
    }

    draw() : void {
        const control = this.controlPoint();
        this.ctx.beginPath();
        this.ctx.strokeStyle = this.color;
        this.ctx.lineWidth = LINE.width;
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';
        this.ctx.moveTo(this.a.position.x, this.a.position.y);
        this.ctx.quadraticCurveTo(control.x, control.y, this.b.position.x, this.b.position.y);
        this.ctx.stroke();
        this.ctx.closePath();
    }

    send(packet: Packet, from: Node, to: Node) {
        this.packetsInTransit.push({ packet, from, to, progress: 0 });
    }

    update() {
        this.draw();
        const control = this.controlPoint();
        this.packetsInTransit = this.packetsInTransit.filter(transit => {
            transit.progress += this.speed / (this.latency * 60); //this makes it in seconds

            if (transit.progress >= 1) {
                transit.to.recievePackets(transit.packet);
                return false; //ie remove this from list
            }
            //follow the drawn curve, reversed when travelling b -> a
            const param = transit.from === this.a ? transit.progress : 1 - transit.progress;
            const pos = this.pointAt(param, control);
            transit.packet.draw(this.ctx, pos);
            return true;
        });
    }

}
