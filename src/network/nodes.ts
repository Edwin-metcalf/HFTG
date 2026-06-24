import { Link } from "./links";
import { Packet } from "./packets";
import { Firm } from "../player"

export interface XYpoint{
    x: number;
    y: number;
}
export abstract class Node {
    //this is slow ahh que maybe write your own with double pointer to front and back for speed
    packetQueue: Packet[] = [];
    id: number;
    position: XYpoint;

    processingPower: number;
    //queue this should be a queue of packets

    //data type for 
    incomingLinks: Link[];
    outgoingLinks: Link[];

    player: Firm;

    constructor(position: XYpoint, player: Firm){
        this.position = position;
        //currently id is random need a way to make sure that they are all unique
        //the id could also just be like the name
        this.id = Math.floor(Math.random() * (1000 - 1 + 1)) + 1;
        this.processingPower = 10

        this.incomingLinks = [];
        this.outgoingLinks = [];
        this.player = player;
    }
    draw(ctx: CanvasRenderingContext2D) : void {
        ctx.beginPath();
        ctx.arc(this.position.x, this.position.y, 20, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle= '#000000'
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    recievePackets(packet: Packet): void {
        this.packetQueue.push(packet);
    }
    //this had time passed into it but if the calculation is happening at then end then it should check time there
    update(): void {
        if (!this.packetQueue || this.packetQueue.length < 1){
            return;
        }
        const packetToProcess = this.packetQueue.shift();
        if (packetToProcess){
            this.processPacket(packetToProcess)
        }
    }

    processPacket(packet: Packet): void {
        for (const link of this.outgoingLinks) {
            if (packet.dest === link.to) {
                link.movePacket(packet);
            }
        }
    }

}
export class FirmNode extends Node {
    //this is like the node that the player.ts has the visual and logic
    draw(ctx: CanvasRenderingContext2D): void {
        ctx.fillRect(this.position.x - 20, this.position.y -20, 40, 40)
    }

    processPacket(packet: Packet): void {
        for (const link of this.outgoingLinks) {
            if (packet.dest === link.to) {
                console.log("going to destination");
                link.movePacket(packet);
                return;
            }
        }
        // if this fails then we need to do some ending saying there is no path to the dest
        console.log("failed no connection to destination ");
    }

}
export class StockExchangeNode extends Node {
    symbol: string = "";
    price: number = 0;
    //couple ways to do this have event between two nodes and then check the price there
    //or each node could have a list of "stocks" and prices and check within that this 
    //approach would be harder to impliment but possibly more fun
    processPacket(packet: Packet): void {
        /* this seems like a possible implementation but eventually may need 
        to do like a graph finding algorithm like dijstras 
        if (packet.source == this){
            for (const link of this.outgoingLinks) {
                link.movePacket(packet)
            }
        } else if (packet.dest === this) {
            this.calculateProfit(packet)
        }
            */
        if (packet.dest === this) {
            console.log("arrived")
            this.calculateProfit(packet);
        } else {
            //if not final just forward it along 
            for (const link of this.outgoingLinks) {
                link.movePacket(packet);
                return;
            }
        }
    }
    setNewPrice(symbol: string, price: number) {
        this.symbol = symbol;
        this.price = price;
    }

    calculateProfit(packet: Packet): void {
        if (packet.symbol === this.symbol) {
            let profit = this.price - packet.price;
            this.player.money += profit;
            console.log(`total money ${this.player.money} + profit: ${profit}`);
        }
    }
}