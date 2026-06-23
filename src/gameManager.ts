import { Link } from "./network/links";
import { StockExchangeNode, type Node, type XYpoint } from "./network/nodes";
import { Packet } from "./network/packets";
import type { Firm } from "./player";

export enum GameState {
    PlacingFirm = "PLACINGFIRM",
    SpawningExchanges = "SPAWNINGEXCHANGES",
    Playing = "PLAYING",
}
export class GameManager {
    elapsedTime: number;
    player: Firm;

    nodeList: Node[] = [];
    linkList: Link[] = [];

    tick: number = 0;
    spawnRate: number = 120;

    ctx: CanvasRenderingContext2D;
    mousePos: XYpoint | null = null;

    gameState: GameState;

    //this is a variable to help the link placement remeber starting node
    //and not always add links even if they were not properly placed
    lastStartingNode: Node | null = null;


    constructor(player: Firm, ctx: CanvasRenderingContext2D) {
        this.elapsedTime = 0;
        this.player = player;
        this.ctx = ctx;
        this.gameState = GameState.PlacingFirm;
    }
    

    update(frameCount: number){
        if (this.gameState === GameState.PlacingFirm) return;
        this.tick++
        if (this.tick % this.spawnRate === 0) {
            this.spawnPacket();
        }
        if (this.tick === 100) {
            this.gameState = GameState.SpawningExchanges;
            this.spawnStockExhanges();
            this.gameState = GameState.Playing;

        }
        if (this.lastStartingNode) {
            this.drawLinkPreview();
        }
        for (const link of this.linkList) {
            link.draw(this.ctx);
        }
        for(const node of this.nodeList) {
            node.draw(this.ctx);
        }

    }
    //heper for nodes positions
    getNodeAtPosition(pos: XYpoint, radius: number): Node | null {
        for (const node of this.nodeList) {
            const dist = Math.sqrt((pos.x - node.position.x)**2 + (pos.y - node.position.y)**2)
            if (dist < radius) return node;
        }
        return null;
    }

    getRandomIndices<T>(list: T[]): [number, number] | null {
        if (list.length < 2) return null;
        const indices = new Set<number>();

        while (indices.size < 2) {
            const randomIndex = Math.floor(Math.random() * list.length);
            indices.add(randomIndex);
        }
        return Array.from(indices) as [number, number];
    }

    spawnPacket(){
        let spawnNode: StockExchangeNode | null = null;
        let destNode: StockExchangeNode | null = null;

        const exchanges = this.nodeList.filter(
            node => node instanceof StockExchangeNode
        );

        const indices = this.getRandomIndices(exchanges);
        if (indices === null) return;
        spawnNode = exchanges[indices[0]];
        destNode = exchanges[indices[1]];

        let createdAt = this.elapsedTime;
        let price = 100;
        let symbol = "AAPL"; //place holder generate symbols

        spawnNode.setNewPrice(symbol, price);
        destNode.setNewPrice(symbol, price + 1);

        let packet = new Packet(spawnNode, destNode,symbol,price,createdAt);
        spawnNode?.recievePackets(packet);
    }

    getRandomXYpoint(): XYpoint {
        //this will need to be more complicated as not to spawn over other nodes
        const padding = 100;
        const x = Math.random() * (this.ctx.canvas.width - padding);
        const y = Math.random() * (this.ctx.canvas.height - padding);

        return {x,y}
    }
    spawnStockExhanges() {
        let stockExchang1 = new StockExchangeNode(this.getRandomXYpoint(), this.player);
        let stockExchang2 = new StockExchangeNode(this.getRandomXYpoint(), this.player);

        this.nodeList.push(stockExchang1);
        this.nodeList.push(stockExchang2);
    }

    startLink(pos: XYpoint) {
        let startNode = this.getNodeAtPosition(pos, 100);
        if (!startNode) return null;

        this.lastStartingNode = startNode;
        this.ctx.beginPath();
        
    }

    placingLink(pos: XYpoint) {
        this.mousePos = pos;
    }

    placeLink(pos: XYpoint) {
        let endNode = this.getNodeAtPosition(pos, 100);
        if (!endNode || !this.lastStartingNode) {
            //reset starting node on failure
            this.lastStartingNode = null;
            return null;
        }

        let createdLink = new Link(endNode, this.lastStartingNode);
        endNode.incomingLinks.push(createdLink);
        this.lastStartingNode.outgoingLinks.push(createdLink);
        this.linkList.push(createdLink);

        this.ctx.closePath();
        this.lastStartingNode = null;
    }
    drawLinkPreview() {
        if (!this.lastStartingNode || !this.mousePos) return;
        this.ctx.beginPath();
        this.ctx.moveTo(this.lastStartingNode.position.x, this.lastStartingNode.position.y);
        this.ctx.lineTo(this.mousePos.x, this.mousePos.y);
        this.ctx.strokeStyle = '#000000';
        this.ctx.lineWidth = 10;
        this.ctx.stroke();
    }
}