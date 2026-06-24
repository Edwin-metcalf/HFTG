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
    ctx: CanvasRenderingContext2D;

    packetsInTransit: { packet: Packet, progress: number }[] =[];

    constructor(to: Node, from: Node, ctx: CanvasRenderingContext2D){
        this.to = to;
        this.from = from;
        this.latency = 30;
        this.bandwidth = 5;
        this.cost = 100;
        this.ctx = ctx;
    }
    draw() : void {
        this.ctx.beginPath();
        this.ctx.strokeStyle = '#ff0000';
        this.ctx.lineWidth = 12;

        this.ctx.moveTo(this.from.position.x, this.from.position.y);
        this.ctx.lineTo(this.to.position.x, this.to.position.y);
        this.ctx.stroke();

        this.ctx.closePath();
    }

    movePacket(packet: Packet) {
        //draw something on the screen
        this.packetsInTransit.push({ packet, progress: 0});
    }

    update() {
        this.draw();
        this.packetsInTransit = this.packetsInTransit.filter(transit => {
            transit.progress += 1 / (this.latency * 60); //this makes it in seconds

            if (transit.progress >= 1) {
                this.to.recievePackets(transit.packet);
                return false; //ie remove this from list
            }
            const x = this.from.position.x + (this.to.position.x - this.from.position.x) * transit.progress;
            const y = this.from.position.y + (this.to.position.y - this.from.position.y) * transit.progress;
            transit.packet.draw(this.ctx, {x,y});
            return true;
        });
    }

}