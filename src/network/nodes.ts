import { Link } from "./links";
import { Packet } from "./packets";
import { Firm } from "../player"
import { FONT, MONO, STATION, THEME } from "../theme";

export interface XYpoint{
    x: number;
    y: number;
}

export interface NodeEvents {
    onProfit?: (amount: number, pos: XYpoint) => void;
    onExpired?: (packet: Packet, pos: XYpoint) => void;
    onRejected?: (packet: Packet, pos: XYpoint) => void;
}

export abstract class Node {
    //this is slow ahh que maybe write your own with double pointer to front and back for speed
    packetQueue: Packet[] = [];
    id: number;
    position: XYpoint;

    processingPower: number;
    //queue this should be a queue of packets

    //every cable attached to this node, directionless
    links: Link[];

    player: Firm;
    events: NodeEvents;

    constructor(position: XYpoint, player: Firm, events: NodeEvents = {}){
        this.position = position;
        //currently id is random need a way to make sure that they are all unique
        //the id could also just be like the name
        this.id = Math.floor(Math.random() * (1000 - 1 + 1)) + 1;
        this.processingPower = 10

        this.links = [];
        this.player = player;
        this.events = events;
    }
    draw(ctx: CanvasRenderingContext2D) : void {
        ctx.beginPath();
        ctx.arc(this.position.x, this.position.y, STATION.radius, 0, Math.PI * 2);
        ctx.fillStyle = THEME.stationFill;
        ctx.fill();
        ctx.strokeStyle = THEME.stationStroke;
        ctx.lineWidth = STATION.stroke;
        ctx.stroke();
        ctx.closePath();
    }

    recievePackets(packet: Packet): void {
        this.packetQueue.push(packet);
    }

    //time is elapsed seconds so packets can expire while they wait
    update(time: number): void {
        if (this.packetQueue.length < 1){
            return;
        }
        const packetToProcess = this.packetQueue.shift();
        if (!packetToProcess) return;

        if (time > packetToProcess.expiresAt) {
            this.events.onExpired?.(packetToProcess, this.position);
            return;
        }
        this.processPacket(packetToProcess);
    }

    //finds the next hop toward the packet destination and hands the packet off
    protected forward(packet: Packet): boolean {
        const nextHop = findNextHop(this, packet.dest);
        if (!nextHop) {
            //no known path yet, hold onto it and retry when links change
            this.packetQueue.push(packet);
            return false;
        }
        const link = this.links.find(cable => cable.other(this) === nextHop);
        if (!link) {
            this.packetQueue.push(packet);
            return false;
        }
        link.send(packet, this, nextHop);
        return true;
    }

    processPacket(packet: Packet): void {
        this.forward(packet);
    }

}

//breadth first search across the cable graph to find the first step toward dest
export function findNextHop(from: Node, dest: Node): Node | null {
    if (from === dest) return null;

    const visited = new Set<Node>([from]);
    const queue: { node: Node; firstHop: Node }[] = [];

    for (const link of from.links) {
        const neighbor = link.other(from);
        if (neighbor && !visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push({ node: neighbor, firstHop: neighbor });
        }
    }

    while (queue.length > 0) {
        const current = queue.shift()!;
        if (current.node === dest) return current.firstHop;
        for (const link of current.node.links) {
            const neighbor = link.other(current.node);
            if (neighbor && !visited.has(neighbor)) {
                visited.add(neighbor);
                queue.push({ node: neighbor, firstHop: current.firstHop });
            }
        }
    }
    return null;
}

interface ProcessingEntry {
    packet: Packet;
    ticksLeft: number;
    //ticks since this packet arrived, used for the arrival flash
    age: number;
}

export class FirmNode extends Node {
    //how many ticks the HQ takes to clear one packet (1 second)
    processingTicks: number = 60;
    private processingQueue: ProcessingEntry[] = [];

    //this is like the node that the player.ts has the visual and logic
    draw(ctx: CanvasRenderingContext2D): void {
        const half = STATION.hqSize / 2;
        const x = this.position.x - half;
        const y = this.position.y - half;

        //queued packets stack up as draining bars above the HQ
        this.drawQueue(ctx);

        ctx.beginPath();
        ctx.roundRect(x, y, STATION.hqSize, STATION.hqSize, 10);
        ctx.fillStyle = THEME.hqFill;
        ctx.fill();
        ctx.lineWidth = 4;
        ctx.strokeStyle = THEME.stationFill;
        ctx.stroke();
        ctx.closePath();

        ctx.fillStyle = THEME.hqText;
        ctx.font = `bold 14px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('HQ', this.position.x, this.position.y + 1);
        ctx.textBaseline = 'alphabetic';
    }

    //one bar per packet: a fresh packet flashes so arrivals are obvious, then
    //sits full while queued, and the front (bottom) bar drains as it is processed
    private drawQueue(ctx: CanvasRenderingContext2D): void {
        if (this.processingQueue.length === 0) return;

        const barWidth = 72;
        const barHeight = 7;
        const gap = 6;
        const maxBars = 9;
        const flashTicks = 14;
        const shown = Math.min(this.processingQueue.length, maxBars);
        const hqTop = this.position.y - STATION.hqSize / 2;

        ctx.save();
        for (let i = 0; i < shown; i++) {
            const entry = this.processingQueue[i];
            const y = hqTop - 14 - i * (barHeight + gap);
            const x = this.position.x - barWidth / 2;
            const active = i === 0;
            const flashing = entry.age < flashTicks;

            //track
            ctx.beginPath();
            ctx.roundRect(x, y - barHeight / 2, barWidth, barHeight, barHeight / 2);
            ctx.fillStyle = 'rgba(47, 42, 38, 0.12)';
            ctx.fill();

            //fill: active bar empties, waiting bars stay full
            const remaining = active
                ? Math.min(1, Math.max(0, entry.ticksLeft / this.processingTicks))
                : 1;
            if (remaining > 0) {
                let colour = 'rgba(47, 42, 38, 0.55)';
                if (flashing) colour = THEME.warning;
                else if (active) colour = THEME.packetProcessed;

                ctx.beginPath();
                ctx.roundRect(x, y - barHeight / 2, barWidth * remaining, barHeight, barHeight / 2);
                ctx.fillStyle = colour;
                ctx.fill();
            }
        }
        ctx.restore();
    }

    recievePackets(packet: Packet): void {
        if (packet.processed) {
            this.packetQueue.push(packet);
            return;
        }
        this.processingQueue.push({ packet, ticksLeft: this.processingTicks, age: 0 });
    }

    update(time: number): void {
        //forward anything that has already been processed
        if (this.packetQueue.length > 0) {
            const waiting = this.packetQueue.shift()!;
            if (time > waiting.expiresAt) {
                this.events.onExpired?.(waiting, this.position);
            } else {
                this.processPacket(waiting);
            }
        }

        if (this.processingQueue.length === 0) return;

        //age every queued packet so arrivals can flash
        for (const entry of this.processingQueue) {
            entry.age++;
        }

        //only the front packet is worked on; the rest wait their turn
        const current = this.processingQueue[0];

        if (time > current.packet.expiresAt) {
            this.events.onExpired?.(current.packet, this.position);
            this.processingQueue.shift();
            return;
        }

        current.ticksLeft--;
        if (current.ticksLeft <= 0) {
            //processing at the HQ is what makes a packet tradeable
            current.packet.processed = true;
            this.processPacket(current.packet);
            this.processingQueue.shift();
        }
    }

    processPacket(packet: Packet): void {
        this.forward(packet);
    }

}
export class StockExchangeNode extends Node {
    symbol: string = "";
    price: number = 0;
    //the price actually shown on screen, refreshed slowly so it stays readable
    displayPrice: number = 0;
    private displayCounter = 0;
    basePrice: number = 100;
    //how much the price moves around each tick
    volatility: number = 0.2;
    //couple ways to do this have event between two nodes and then check the price there
    //or each node could have a list of "stocks" and prices and check within that this 
    //approach would be harder to impliment but possibly more fun
    processPacket(packet: Packet): void {
        if (packet.dest === this) {
            if (packet.processed) {
                this.calculateProfit(packet);
            } else {
                //reached the destination without going through the HQ
                this.events.onRejected?.(packet, this.position);
            }
            return;
        }
        this.forward(packet);
    }

    //live price discovery: random walk with a gentle pull back to base
    tickPrice(): void {
        const noise = (Math.random() - 0.5) * this.volatility;
        this.price += (this.basePrice - this.price) * 0.0005 + noise;
        if (this.price < 1) this.price = 1;

        //refresh the on-screen quote about twice a second
        this.displayCounter++;
        if (this.displayCounter >= 30) {
            this.displayCounter = 0;
            this.displayPrice = this.price;
        }
    }

    setNewPrice(symbol: string, price: number) {
        this.symbol = symbol;
        this.price = price;
        this.displayPrice = price;
        this.basePrice = price;
    }

    draw(ctx: CanvasRenderingContext2D): void {
        super.draw(ctx);
        ctx.textAlign = 'center';
        ctx.fillStyle = THEME.ink;
        ctx.font = `bold 18px ${FONT}`;
        ctx.fillText(this.symbol, this.position.x, this.position.y + 52);
        ctx.fillStyle = THEME.inkSoft;
        ctx.font = `16px ${MONO}`;
        ctx.fillText(this.displayPrice.toFixed(2), this.position.x, this.position.y + 74);
    }

    calculateProfit(packet: Packet): void {
        const profit = (this.price - packet.price) * packet.size;
        this.player.money += profit;
        this.events.onProfit?.(profit, this.position);
    }
}
