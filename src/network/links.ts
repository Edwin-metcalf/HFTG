import { Node } from "./nodes";
import type { Packet } from "./packets";
//this was also abstract but isnt now and can be later with unique link types
export class Link {
    to: Node;
    from: Node;

    //maybe simplify or have latency how fast orders travel
    //bandwidth how many concurrent orders the user can do
    //length: number; calculate the length from the to and the from 
    latency: number;
    bandwidth: number;
    cost: number;

    constructor(to: Node, from: Node){
        this.to = to;
        this.from = from;
        this.latency = 5;
        this.bandwidth = 5;
        this.cost = 100;
    }
    draw(ctx: CanvasRenderingContext2D) : void {
        ctx.beginPath();
        ctx.strokeStyle = '#ff0000';
        ctx.lineWidth = 12;

        ctx.moveTo(this.from.position.x, this.from.position.y);
        ctx.lineTo(this.to.position.x, this.to.position.y);
        ctx.stroke();
        
        ctx.closePath();
    }

    movePacket(packet: Packet) {
        //draw something on the screen
        this.to.recievePackets(packet);
    }

}