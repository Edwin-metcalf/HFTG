import { Link, cableCost } from "./network/links";
import { StockExchangeNode, FirmNode, findNextHop, type Node, type NodeEvents, type XYpoint } from "./network/nodes";
import { Packet } from "./network/packets";
import type { Firm } from "./player";
import { FONT, LINE, MONO, STATION, THEME } from "./theme";

export enum GameState {
    Start = "START",
    PlacingFirm = "PLACINGFIRM",
    SpawningExchanges = "SPAWNINGEXCHANGES",
    Playing = "PLAYING",
    ChoosingUpgrade = "CHOOSINGUPGRADE",
}

export type UpgradeId = "cables" | "hq";

export interface UpgradeOption {
    id: UpgradeId;
    title: string;
    description: string;
}

//each ticker is a tradeable pair of markets; a new ticker = a new pair to connect
const SYMBOLS = ["AAPL", "BTC", "GOLD", "OIL", "ETH", "NVDA", "TSLA", "SOL"];

//how long an opportunity (its whole burst) stays tradeable, in seconds
const OPPORTUNITY_TTL = 24;
//minimum price gap before we consider spawning a trade
const MIN_SPREAD = 0.6;
//how close the cursor must be to grab or snap to a node
const NODE_HIT_RADIUS = 80;
//one share per packet; a trade fires a whole burst of them
const PACKET_SIZE = 1;
//how many share-packets a single opportunity sends down the wire
const BATCH_MIN = 4;
const BATCH_MAX = 8;

//progression runs in days (minimetro-style weeks)
//each day is a bit longer than the last, so upgrades arrive further apart
const BASE_DAY_TICKS = 60 * 60; //60 seconds on day 1
const DAY_GROWTH_TICKS = 60 * 10; //+10 seconds each day
const MAX_PAIRS = 4;

//trade flow ramps with the day; upgrades are how you keep up
const BASE_SPAWN_INTERVAL = 600; //10s between opportunities on day 1
const SPAWN_DAY_DECAY = 0.88;

//cable upgrade: +75% speed per level
const CABLE_SPEED_STEP = 0.75;
//hq upgrade: -25% processing time per level
const BASE_PROCESSING_TICKS = 60;
const HQ_TIME_FACTOR = 0.75;

interface FloatingText {
    text: string;
    pos: XYpoint;
    life: number;
    color: string;
}

export class GameManager {
    elapsedTime: number;
    player: Firm;

    nodeList: Node[] = [];
    linkList: Link[] = [];
    floatingTexts: FloatingText[] = [];

    tick: number = 0;

    //day cycle + upgrade levels
    day: number = 1;
    cableLevel: number = 1;
    hqLevel: number = 1;
    private dayTicks: number = 0;
    private spawnTimer: number = BASE_SPAWN_INTERVAL;

    ctx: CanvasRenderingContext2D;
    mousePos: XYpoint | null = null;

    gameState: GameState;

    //this is a variable to help the link placement remeber starting node
    //and not always add links even if they were not properly placed
    lastStartingNode: Node | null = null;

    //pointer feedback
    hoveredNode: Node | null = null;
    linkTarget: Node | null = null;
    linkTargetValid: boolean = false;
    splitTarget: { link: Link, node: Node, t: number, dist: number, extraCost: number, point: XYpoint } | null = null;
    editingLink: Link | null = null;
    editHandlePos: XYpoint | null = null;
    editSplitTarget: { node: Node, extraCost: number } | null = null;

    private events: NodeEvents;


    constructor(player: Firm, ctx: CanvasRenderingContext2D) {
        this.elapsedTime = 0;
        this.player = player;
        this.ctx = ctx;
        this.gameState = GameState.Start;

        this.events = {
            onProfit: (amount, pos) => {
                this.player.reputation += 1;
                this.pushText(`+$${amount.toFixed(2)}`, pos, THEME.positive);
            },
            onExpired: (_packet, pos) => {
                this.player.reputation = Math.max(0, this.player.reputation - 1);
                this.pushText('EXPIRED', pos, THEME.negative);
            },
            onRejected: (_packet, pos) => {
                this.player.reputation = Math.max(0, this.player.reputation - 1);
                this.pushText('NO HQ', pos, THEME.warning);
            },
        };
    }


    update(){
        if (this.gameState === GameState.Start) {
            this.drawBackground();
            return;
        }

        if (this.gameState === GameState.PlacingFirm) {
            this.drawBackground();
            this.updatePointerState();
            this.drawLinkPreview();
            for (const link of this.linkList) {
                if (link.dead && link.packetsInTransit.length === 0) continue;
                link.draw();
            }
            for(const node of this.nodeList) {
                node.draw(this.ctx);
            }
            this.drawHighlights();
            this.updateFloatingTexts();
            this.drawHint();
            return;
        }

        if (this.gameState === GameState.Playing) {
            this.simulate();
        }

        this.drawBackground();
        this.updatePointerState();

        //preview cable tucks under the stations
        this.drawLinkPreview();

        for (const link of this.linkList) {
            if (link.dead && link.packetsInTransit.length === 0) continue;
            if (!link.dead) link.update();
            else link.draw();
        }
        for(const node of this.nodeList) {
            if (this.gameState === GameState.Playing) node.update(this.elapsedTime);
            node.draw(this.ctx);
        }

        this.drawHighlights();
        this.updateFloatingTexts();
        this.drawHint();
        this.drawDayBar();
        this.drawHUD();
    }

    //advances the world by one tick, but only while actually playing
    private simulate() {
        this.tick++;
        this.elapsedTime = this.tick / 60;
        this.dayTicks++;

        if (this.tick === 100) {
            this.spawnStockExhanges();
        }

        this.spawnTimer--;
        if (this.spawnTimer <= 0) {
            this.spawnPacket();
            this.spawnTimer = this.spawnInterval();
        }

        for (const node of this.nodeList) {
            if (node instanceof StockExchangeNode) node.tickPrice();
        }

        if (this.dayTicks >= this.dayLength()) {
            this.dayTicks = this.dayLength();
            this.gameState = GameState.ChoosingUpgrade;
        }
    }

    //----- progression -----

    //effective cable speed multiplier
    cableSpeed(): number {
        return 1 + CABLE_SPEED_STEP * (this.cableLevel - 1);
    }

    //HQ ticks to clear one packet
    processingTicks(): number {
        return Math.max(12, Math.round(BASE_PROCESSING_TICKS * Math.pow(HQ_TIME_FACTOR, this.hqLevel - 1)));
    }

    //ticks between opportunities for the current day
    spawnInterval(): number {
        return Math.max(30, Math.round(BASE_SPAWN_INTERVAL * Math.pow(SPAWN_DAY_DECAY, this.day - 1)));
    }

    //how long the current day lasts, in ticks
    dayLength(): number {
        return BASE_DAY_TICKS + (this.day - 1) * DAY_GROWTH_TICKS;
    }

    dayProgress(): number {
        return Math.min(1, this.dayTicks / this.dayLength());
    }

    //the two upgrades offered at the end of each day
    upgradeChoices(): UpgradeOption[] {
        const nextCableSpeed = 1 + CABLE_SPEED_STEP * this.cableLevel;
        const nextHqTicks = Math.max(12, Math.round(BASE_PROCESSING_TICKS * Math.pow(HQ_TIME_FACTOR, this.hqLevel)));
        return [
            {
                id: "cables",
                title: "Faster cables",
                description: `Transit ${this.cableSpeed().toFixed(2)}x → ${nextCableSpeed.toFixed(2)}x`,
            },
            {
                id: "hq",
                title: "Faster HQ",
                description: `Processing ${(this.processingTicks() / 60).toFixed(2)}s → ${(nextHqTicks / 60).toFixed(2)}s`,
            },
        ];
    }

    chooseUpgrade(id: UpgradeId) {
        if (this.gameState !== GameState.ChoosingUpgrade) return;

        if (id === "cables") {
            this.cableLevel++;
            this.applyCableLevel();
        } else {
            this.hqLevel++;
            this.applyHqLevel();
        }

        this.startNextDay();
    }

    restart() {
        this.elapsedTime = 0;
        this.nodeList = [];
        this.linkList = [];
        this.floatingTexts = [];
        this.tick = 0;
        this.day = 1;
        this.cableLevel = 1;
        this.hqLevel = 1;
        this.dayTicks = 0;
        this.spawnTimer = BASE_SPAWN_INTERVAL;
        this.lastStartingNode = null;
        this.hoveredNode = null;
        this.linkTarget = null;
        this.linkTargetValid = false;
        this.mousePos = null;
        this.player.money = 556;
        this.player.reputation = 0;
        this.gameState = GameState.Start;
    }

    private applyCableLevel() {
        const speed = this.cableSpeed();
        for (const link of this.linkList) {
            link.speed = speed;
        }
    }

    private applyHqLevel() {
        const ticks = this.processingTicks();
        for (const node of this.nodeList) {
            if (node instanceof FirmNode) node.processingTicks = ticks;
        }
    }

    private startNextDay() {
        this.day++;
        this.dayTicks = 0;
        this.spawnTimer = this.spawnInterval();
        this.spawnNewMarketPair();
        this.gameState = GameState.Playing;
    }

    //----- state / spawning -----

    //tracks what the pointer is hovering / snapping to
    private updatePointerState() {
        if (this.editingLink) {
            this.hoveredNode = null;
            this.linkTarget = null;
            this.linkTargetValid = false;
            if (this.mousePos) {
                this.ctx.canvas.style.cursor = 'pointer';
            } else {
                this.ctx.canvas.style.cursor = 'default';
            }
            return;
        }
        const start = this.lastStartingNode;
        this.hoveredNode = null;
        this.linkTarget = null;
        this.linkTargetValid = false;

        if (!this.mousePos) {
            this.ctx.canvas.style.cursor = 'default';
            return;
        }

        this.splitTarget = null;
        if (start) {
            const target = this.getNodeAtPosition(this.mousePos, NODE_HIT_RADIUS);
            this.linkTarget = target;
            if (target) {
                const alreadyLinked = start.links.some(cable => cable.connects(start, target));
                const costDirect = cableCost(start.position, target.position);
                const valid = target !== start && !alreadyLinked && costDirect <= this.player.money;
                if (valid) {
                    this.linkTargetValid = true;
                } else {
                    this.linkTargetValid = false;
                }
            }
            const splitCandidate = this.findSplitCandidate(start, this.mousePos);
            if (splitCandidate && !this.linkTargetValid) {
                this.splitTarget = splitCandidate;
                this.linkTargetValid = splitCandidate.extraCost <= this.player.money;
            }
            this.ctx.canvas.style.cursor = 'pointer';
            return;
        }

        const split = this.findSplitCandidate(null, this.mousePos);
        if (split) {
            this.splitTarget = split;
            this.ctx.canvas.style.cursor = 'pointer';
            return;
        }
        const hitLink = this.findLinkAt(this.mousePos);
        if (hitLink) {
            this.ctx.canvas.style.cursor = 'grab';
            return;
        }
        this.hoveredNode = this.getNodeAtPosition(this.mousePos, NODE_HIT_RADIUS);
        this.ctx.canvas.style.cursor = this.hoveredNode ? 'pointer' : 'default';
    }

    //heper for nodes positions
    private closestPointOnSegment(a: XYpoint, b: XYpoint, p: XYpoint): { point: XYpoint, t: number } {
        const abx = b.x - a.x;
        const aby = b.y - a.y;
        const apx = p.x - a.x;
        const apy = p.y - a.y;
        const abLen2 = abx * abx + aby * aby;
        if (abLen2 === 0) {
            return { point: { x: a.x, y: a.y }, t: 0 };
        }
        let t = (apx * abx + apy * aby) / abLen2;
        if (t < 0) t = 0;
        if (t > 1) t = 1;
        return {
            point: { x: a.x + abx * t, y: a.y + aby * t },
            t
        };
    }

    private findSplitCandidate(startNode: Node | null, _pos: XYpoint) {
        const candidates: Array<{ link: Link, node: Node, t: number, dist: number, extraCost: number, point: XYpoint }> = [];
        const snap = NODE_HIT_RADIUS;
        for (const link of this.linkList) {
            if (startNode && (link.a === startNode || link.b === startNode)) continue;
            for (const node of this.nodeList) {
                if (!(node instanceof StockExchangeNode)) continue;
                if (node.links.length > 0) continue;
                if (startNode && node === startNode) continue;
                const cp = this.closestPointOnSegment(link.a.position, link.b.position, node.position);
                const dist = Math.hypot(node.position.x - cp.point.x, node.position.y - cp.point.y);
                if (dist > snap) continue;
                if (cp.t <= 0.001 || cp.t >= 0.999) continue;
                const cOld = cableCost(link.a.position, link.b.position);
                const c1 = cableCost(link.a.position, node.position);
                const c2 = cableCost(node.position, link.b.position);
                let extra = (c1 + c2) - cOld;
                if (extra < 0) extra = 0;
                candidates.push({ link, node, t: cp.t, dist, extraCost: extra, point: cp.point });
            }
        }
        if (candidates.length === 0) return null;
        candidates.sort((a, b) => a.dist - b.dist || a.extraCost - b.extraCost);
        return candidates[0];
    }

    getNodeAtPosition(pos: XYpoint, radius: number): Node | null {
        for (const node of this.nodeList) {
            const dist = Math.sqrt((pos.x - node.position.x)**2 + (pos.y - node.position.y)**2)
            if (dist < radius) return node;
        }
        return null;
    }

    placeFirmNode(pos: XYpoint) {
        const firmNode = new FirmNode(pos, this.player, this.events);
        firmNode.processingTicks = this.processingTicks();
        this.nodeList.push(firmNode);
        this.gameState = GameState.Playing;
    }

    spawnPacket(){
        const exchanges = this.nodeList.filter(
            (node): node is StockExchangeNode => node instanceof StockExchangeNode
        );

        //group markets by the symbol they quote so we can find pairs
        const bySymbol = new Map<string, StockExchangeNode[]>();
        for (const exchange of exchanges) {
            const group = bySymbol.get(exchange.symbol) ?? [];
            group.push(exchange);
            bySymbol.set(exchange.symbol, group);
        }

        const opportunities: { source: StockExchangeNode; dest: StockExchangeNode; symbol: string; spread: number }[] = [];
        for (const [symbol, group] of bySymbol) {
            if (group.length < 2) continue;
            for (let i = 0; i < group.length; i++) {
                for (let j = i + 1; j < group.length; j++) {
                    const a = group[i];
                    const b = group[j];
                    const spread = Math.abs(a.price - b.price);
                    if (spread < MIN_SPREAD) continue;
                    //buy where it is cheap, sell where it is expensive
                    const source = a.price < b.price ? a : b;
                    const dest = a.price < b.price ? b : a;
                    opportunities.push({ source, dest, symbol, spread });
                }
            }
        }
        if (opportunities.length === 0) return;

        //only trade a pair once the player can actually route it: source -> HQ -> dest.
        //new tickers sit idle until cabled in, so they never cost reputation unfairly.
        const hq = this.nodeList.find((node): node is FirmNode => node instanceof FirmNode);
        const routable = hq
            ? opportunities.filter(opp => findNextHop(opp.source, hq) !== null && findNextHop(hq, opp.dest) !== null)
            : [];
        if (routable.length === 0) return;

        const pick = routable[Math.floor(Math.random() * routable.length)];

        //a single opportunity is really a batch of share-packets: each one is
        //queued and processed at the HQ one at a time, so a 98->100 move only
        //pays the spread per packet, not the whole batch at once
        const batch = BATCH_MIN + Math.floor(Math.random() * (BATCH_MAX - BATCH_MIN + 1));
        const expiresAt = this.elapsedTime + OPPORTUNITY_TTL;
        for (let i = 0; i < batch; i++) {
            const packet = new Packet(pick.source, pick.dest, pick.symbol, pick.source.price, this.elapsedTime);
            packet.expiresAt = expiresAt;
            packet.size = PACKET_SIZE;
            pick.source.recievePackets(packet);
        }
        this.pushText(`\u00d7${batch} ${pick.symbol}`, pick.source.position, THEME.inkSoft);
    }

    getRandomXYpoint(): XYpoint {
        const padding = 140;
        const width = this.ctx.canvas.width;
        const height = this.ctx.canvas.height;

        let fallback: XYpoint = { x: padding, y: padding };
        for (let attempt = 0; attempt < 30; attempt++) {
            const point = {
                x: padding + Math.random() * (width - padding * 2),
                y: padding + Math.random() * (height - padding * 2),
            };
            fallback = point;
            const clear = this.nodeList.every(node => {
                const dist = Math.sqrt((point.x - node.position.x) ** 2 + (point.y - node.position.y) ** 2);
                return dist > 260;
            });
            if (clear) return point;
        }
        return fallback;
    }

    spawnStockExhanges() {
        //the starting ticker: one pair of markets to connect
        const symbol = SYMBOLS[0];
        for (let i = 0; i < 2; i++) {
            const market = new StockExchangeNode(this.getRandomXYpoint(), this.player, this.events);
            market.setNewPrice(symbol, 100 + (Math.random() * 4 - 2));
            this.nodeList.push(market);
        }
    }

    //adds a brand new ticker pair so the player must lay fresh cables for it
    private spawnNewMarketPair() {
        const exchanges = this.nodeList.filter(
            (node): node is StockExchangeNode => node instanceof StockExchangeNode
        );
        const usedSymbols = new Set(exchanges.map(exchange => exchange.symbol));
        if (usedSymbols.size >= MAX_PAIRS) return;

        const available = SYMBOLS.filter(symbol => !usedSymbols.has(symbol));
        if (available.length === 0) return;

        const symbol = available[Math.floor(Math.random() * available.length)];
        for (let i = 0; i < 2; i++) {
            const market = new StockExchangeNode(this.getRandomXYpoint(), this.player, this.events);
            market.setNewPrice(symbol, 100 + (Math.random() * 4 - 2));
            this.nodeList.push(market);
        }
    }

    startLink(pos: XYpoint) {
        this.cancelEdit();
        this.splitTarget = null;
        let startNode = this.getNodeAtPosition(pos, NODE_HIT_RADIUS);
        if (startNode) {
            this.lastStartingNode = startNode;
            return;
        }
        const hitLink = this.findLinkAt(pos);
        if (hitLink) {
            this.editingLink = hitLink;
            this.editHandlePos = { x: pos.x, y: pos.y };
            this.editSplitTarget = null;
            hitLink.fading = true;
            return;
        }
        const split = this.findSplitCandidate(null, pos);
        if (split && split.extraCost <= this.player.money) {
            this.splitTarget = split;
            this.lastStartingNode = { position: split.point } as Node;
            return;
        }
        this.lastStartingNode = null;
    }

    placingLink(pos: XYpoint) {
        this.mousePos = pos;
        if (this.editingLink) {
            this.editHandlePos = { x: pos.x, y: pos.y };
            const target = this.findEditSplitTarget(this.editingLink, pos);
            this.editSplitTarget = target;
            return;
        }
    }

    cancelEdit() {
        if (this.editingLink) {
            this.editingLink.fading = false;
        }
        this.editingLink = null;
        this.editHandlePos = null;
        this.editSplitTarget = null;
    }

    clearPointer() {
        this.mousePos = null;
        this.hoveredNode = null;
        this.linkTarget = null;
        this.linkTargetValid = false;
        this.splitTarget = null;
        this.cancelEdit();
        this.ctx.canvas.style.cursor = 'default';
    }

    private splitLink(split: { link: Link, node: Node, extraCost: number }) {
        if (split.extraCost > this.player.money) {
            this.pushText('INSUFFICIENT FUNDS', split.node.position, THEME.warning);
            return;
        }
        const link = split.link;
        const m = split.node;
        const a = link.a;
        const b = link.b;
        const ctx = this.ctx;

        this.player.money -= split.extraCost;

        link.fading = true;
        link.dead = true;
        this.linkList = this.linkList.filter(l => l !== link);
        a.links = a.links.filter(l => l !== link);
        b.links = b.links.filter(l => l !== link);

        const l1 = new Link(a, m, ctx);
        const l2 = new Link(m, b, ctx);
        const speed = this.cableSpeed();
        l1.speed = speed;
        l2.speed = speed;
        this.linkList.push(l1, l2);
        a.links.push(l1);
        m.links.push(l1);
        m.links.push(l2);
        b.links.push(l2);
    }

    placeLink(pos: XYpoint) {
        if (this.editingLink) {
            if (this.editSplitTarget && this.editSplitTarget.extraCost <= this.player.money) {
                this.splitLink({ link: this.editingLink, node: this.editSplitTarget.node, extraCost: this.editSplitTarget.extraCost });
            } else if (this.editSplitTarget) {
                this.pushText('INSUFFICIENT FUNDS', this.editSplitTarget.node.position, THEME.warning);
            }
            this.cancelEdit();
            return null;
        }
        const startNode = this.lastStartingNode;
        const split = this.splitTarget;
        if (split) {
            this.splitLink(split);
            this.splitTarget = null;
            this.lastStartingNode = null;
            this.clearPointer();
            return null;
        }
        let endNode = this.getNodeAtPosition(pos, NODE_HIT_RADIUS);
        if (!endNode || !startNode || endNode === startNode) {
            //reset starting node on failure
            this.lastStartingNode = null;
            return null;
        }

        //don't stack cables between the same pair of nodes
        const alreadyLinked = startNode.links.some(cable => cable.connects(startNode, endNode));
        if (alreadyLinked) {
            this.lastStartingNode = null;
            return null;
        }

        const cost = cableCost(startNode.position, endNode.position);
        if (cost > this.player.money) {
            this.pushText('INSUFFICIENT FUNDS', endNode.position, THEME.warning);
            this.lastStartingNode = null;
            return null;
        }

        const createdLink = new Link(startNode, endNode, this.ctx);
        createdLink.speed = this.cableSpeed();
        this.player.money -= createdLink.cost;
        startNode.links.push(createdLink);
        endNode.links.push(createdLink);
        this.linkList.push(createdLink);

        this.lastStartingNode = null;
    }

    drawLinkPreview() {
        if (this.editingLink && this.editHandlePos && this.mousePos) {
            const link = this.editingLink;
            const a = link.a.position;
            const b = link.b.position;
            const m = this.editSplitTarget ? this.editSplitTarget.node.position : this.editHandlePos;
            this.ctx.save();
            this.ctx.globalAlpha = 0.7;
            this.ctx.beginPath();
            this.ctx.moveTo(a.x, a.y);
            this.ctx.lineTo(m.x, m.y);
            this.ctx.lineTo(b.x, b.y);
            this.ctx.strokeStyle = this.editSplitTarget ? (this.editSplitTarget.extraCost <= this.player.money ? THEME.positive : THEME.negative) : THEME.ink;
            this.ctx.lineWidth = LINE.width;
            this.ctx.lineCap = 'round';
            this.ctx.setLineDash([18, 16]);
            this.ctx.stroke();
            this.ctx.restore();
            if (this.editSplitTarget) {
                const cost = this.editSplitTarget.extraCost;
                const affordable = cost <= this.player.money;
                const midX = (a.x + b.x) / 2;
                const midY = (a.y + b.y) / 2 - 14;
                this.ctx.save();
                this.ctx.textAlign = 'center';
                this.ctx.font = `bold 20px ${MONO}`;
                this.ctx.fillStyle = affordable ? THEME.ink : THEME.negative;
                this.ctx.fillText(`$${cost}`, midX, midY);
                this.ctx.restore();
            }
            return;
        }
        if (!this.lastStartingNode || !this.mousePos) return;

        if (this.splitTarget) {
            const split = this.splitTarget;
            const start = split.link.a.position;
            const mid = split.node.position;
            const end = split.link.b.position;
            const color = this.linkTargetValid ? THEME.positive : THEME.negative;
            this.ctx.save();
            this.ctx.globalAlpha = 0.7;
            this.ctx.beginPath();
            this.ctx.moveTo(start.x, start.y);
            this.ctx.lineTo(mid.x, mid.y);
            this.ctx.lineTo(end.x, end.y);
            this.ctx.strokeStyle = color;
            this.ctx.lineWidth = LINE.width;
            this.ctx.lineCap = 'round';
            this.ctx.setLineDash([18, 16]);
            this.ctx.stroke();
            this.ctx.restore();
            const cost = split.extraCost;
            const affordable = cost <= this.player.money;
            const midX = (start.x + end.x) / 2;
            const midY = (start.y + end.y) / 2 - 14;
            this.ctx.save();
            this.ctx.textAlign = 'center';
            this.ctx.font = `bold 20px ${MONO}`;
            this.ctx.fillStyle = affordable ? THEME.ink : THEME.negative;
            this.ctx.fillText(`$${cost}`, midX, midY);
            this.ctx.restore();
            return;
        }

        //snap to the target node when there is one
        const end = this.linkTarget ? this.linkTarget.position : this.mousePos;
        const color = this.linkTarget
            ? (this.linkTargetValid ? THEME.positive : THEME.negative)
            : THEME.ink;

        this.ctx.save();
        this.ctx.globalAlpha = 0.6;
        this.ctx.beginPath();
        this.ctx.moveTo(this.lastStartingNode.position.x, this.lastStartingNode.position.y);
        this.ctx.lineTo(end.x, end.y);
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth = LINE.width;
        this.ctx.lineCap = 'round';
        this.ctx.setLineDash([18, 16]);
        this.ctx.stroke();
        this.ctx.restore();

        //show the running cost of the cable being drawn
        const cost = cableCost(this.lastStartingNode.position, end);
        const affordable = cost <= this.player.money;
        const midX = (this.lastStartingNode.position.x + end.x) / 2;
        const midY = (this.lastStartingNode.position.y + end.y) / 2 - 14;
        this.ctx.save();
        this.ctx.textAlign = 'center';
        this.ctx.font = `bold 20px ${MONO}`;
        this.ctx.fillStyle = affordable ? THEME.ink : THEME.negative;
        this.ctx.fillText(`$${cost}`, midX, midY);
        this.ctx.restore();
    }

    private distanceToSegment(p: XYpoint, a: XYpoint, b: XYpoint): { dist: number, point: XYpoint } {
        const abx = b.x - a.x;
        const aby = b.y - a.y;
        const apx = p.x - a.x;
        const apy = p.y - a.y;
        const abLen2 = abx * abx + aby * aby;
        if (abLen2 === 0) {
            const d = Math.hypot(p.x - a.x, p.y - a.y);
            return { dist: d, point: { x: a.x, y: a.y } };
        }
        let t = (apx * abx + apy * aby) / abLen2;
        if (t < 0) t = 0;
        if (t > 1) t = 1;
        const point = { x: a.x + abx * t, y: a.y + aby * t };
        const dist = Math.hypot(p.x - point.x, p.y - point.y);
        return { dist, point };
    }

    private findLinkAt(pos: XYpoint): Link | null {
        let best: Link | null = null;
        let bestDist = 22;
        for (const link of this.linkList) {
            if (link.dead) continue;
            const res = this.distanceToSegment(pos, link.a.position, link.b.position);
            if (res.dist < bestDist) {
                bestDist = res.dist;
                best = link;
            }
        }
        return best;
    }

    private findEditSplitTarget(link: Link, pos: XYpoint): { node: Node, extraCost: number } | null {
        const candidates: Array<{ node: Node, extraCost: number, dist: number }> = [];
        const snap = NODE_HIT_RADIUS;
        for (const node of this.nodeList) {
            if (!(node instanceof StockExchangeNode)) continue;
            if (node.links.length > 0) continue;
            const dist = Math.hypot(node.position.x - pos.x, node.position.y - pos.y);
            if (dist > snap) continue;
            const cOld = cableCost(link.a.position, link.b.position);
            const c1 = cableCost(link.a.position, node.position);
            const c2 = cableCost(node.position, link.b.position);
            let extra = (c1 + c2) - cOld;
            if (extra < 0) extra = 0;
            candidates.push({ node, extraCost: extra, dist });
        }
        if (candidates.length === 0) return null;
        candidates.sort((a, b) => a.dist - b.dist || a.extraCost - b.extraCost);
        return { node: candidates[0].node, extraCost: candidates[0].extraCost };
    }

    private drawLinkHover() {
        if (this.editingLink || !this.mousePos) return;
        if (this.lastStartingNode) return;
        const hit = this.findLinkAt(this.mousePos);
        if (!hit || hit.dead) return;
        this.ctx.save();
        this.ctx.globalAlpha = 0.4;
        this.ctx.beginPath();
        this.ctx.strokeStyle = THEME.ink;
        this.ctx.lineWidth = LINE.width + 6;
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';
        const control = (hit as any).controlPoint ? (hit as any).controlPoint() : { x: (hit.a.position.x + hit.b.position.x)/2, y: (hit.a.position.y + hit.b.position.y)/2 };
        this.ctx.moveTo(hit.a.position.x, hit.a.position.y);
        this.ctx.quadraticCurveTo(control.x, control.y, hit.b.position.x, hit.b.position.y);
        this.ctx.stroke();
        this.ctx.restore();
    }

    private drawHighlights() {
        const radius = STATION.radius + 9;
        this.drawLinkHover();

        if (this.editSplitTarget && this.editHandlePos) {
            const pulse = radius + Math.sin(this.tick / 8) * 2;
            this.drawRing(this.editSplitTarget.node.position, pulse, THEME.positive, 3, 0.95);
        }

        if (this.splitTarget && this.splitTarget.node) {
            const pulse = radius + Math.sin(this.tick / 8) * 2;
            const color = this.linkTargetValid ? THEME.positive : THEME.negative;
            this.drawRing(this.splitTarget.node.position, pulse, color, 3, 0.95);
        }

        if (this.lastStartingNode) {
            const pulse = radius + Math.sin(this.tick / 8) * 2;
            this.drawRing(this.lastStartingNode.position, pulse, THEME.ink, 3, 0.9);
        }

        if (this.linkTarget) {
            const color = this.linkTargetValid ? THEME.positive : THEME.negative;
            this.drawRing(this.linkTarget.position, radius, color, 3, 0.95);
        } else if (this.hoveredNode) {
            this.drawRing(this.hoveredNode.position, radius, THEME.ink, 3, 0.35);
        }
    }

    private drawRing(pos: XYpoint, radius: number, color: string, width: number, alpha: number) {
        this.ctx.save();
        this.ctx.globalAlpha = alpha;
        this.ctx.beginPath();
        this.ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth = width;
        this.ctx.stroke();
        this.ctx.restore();
    }

    private drawHint() {
        if (this.gameState === GameState.PlacingFirm) {
            this.ctx.save();
            this.ctx.textAlign = 'center';
            this.ctx.fillStyle = THEME.ink;
            this.ctx.font = `28px ${FONT}`;
            this.ctx.fillText(
                'Click anywhere to place your HQ',
                this.ctx.canvas.width / 2,
                this.ctx.canvas.height / 2,
            );
            this.ctx.restore();
            return;
        }
        if (this.linkList.length > 0 || this.nodeList.length < 2) return;
        this.ctx.save();
        this.ctx.textAlign = 'center';
        this.ctx.fillStyle = THEME.inkSoft;
        this.ctx.font = `22px ${FONT}`;
        this.ctx.fillText(
            'Drag a cable from a market to your HQ, then from HQ to the other market',
            this.ctx.canvas.width / 2,
            this.ctx.canvas.height - 60,
        );
        this.ctx.restore();
    }

    pushText(text: string, pos: XYpoint, color: string) {
        this.floatingTexts.push({
            text,
            pos: { x: pos.x, y: pos.y - 40 },
            life: 1,
            color,
        });
    }

    private updateFloatingTexts() {
        this.ctx.textAlign = 'center';
        this.ctx.font = `bold 22px ${FONT}`;
        for (const text of this.floatingTexts) {
            text.life -= 1 / 120;
            text.pos.y -= 0.4;
            this.ctx.globalAlpha = Math.max(text.life, 0);
            this.ctx.fillStyle = text.color;
            this.ctx.fillText(text.text, text.pos.x, text.pos.y);
        }
        this.ctx.globalAlpha = 1;
        this.floatingTexts = this.floatingTexts.filter(text => text.life > 0);
    }

    private drawBackground() {
        this.ctx.fillStyle = THEME.background;
        this.ctx.fillRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.height);
    }

    //top-centre progress bar showing how far through the day we are
    private drawDayBar() {
        const width = 260;
        const height = 8;
        const x = (this.ctx.canvas.width - width) / 2;
        const y = 40;
        const progress = this.dayProgress();

        this.ctx.save();
        this.ctx.beginPath();
        this.ctx.roundRect(x, y, width, height, height / 2);
        this.ctx.fillStyle = 'rgba(47, 42, 38, 0.12)';
        this.ctx.fill();

        if (progress > 0) {
            this.ctx.beginPath();
            this.ctx.roundRect(x, y, Math.max(height, width * progress), height, height / 2);
            this.ctx.fillStyle = THEME.ink;
            this.ctx.fill();
        }

        this.ctx.textAlign = 'center';
        this.ctx.fillStyle = THEME.inkSoft;
        this.ctx.font = `bold 14px ${FONT}`;
        this.ctx.fillText(`DAY ${this.day}`, this.ctx.canvas.width / 2, y - 10);
        this.ctx.restore();
    }

    private drawHUD() {
        this.ctx.textAlign = 'left';
        this.ctx.fillStyle = THEME.ink;
        this.ctx.font = `bold 42px ${MONO}`;
        this.ctx.fillText(`$${this.player.money.toFixed(2)}`, 40, 66);

        this.ctx.font = `20px ${FONT}`;
        this.ctx.fillStyle = THEME.inkSoft;
        this.ctx.fillText(`Day ${this.day}`, 42, 100);
        this.ctx.fillText(`Reputation ${this.player.reputation}`, 42, 130);

        this.ctx.font = `16px ${FONT}`;
        this.ctx.fillText(`Cables ×${this.cableSpeed().toFixed(2)}`, 42, 164);
        this.ctx.fillText(`HQ ${(this.processingTicks() / 60).toFixed(2)}s`, 42, 188);
    }
}
