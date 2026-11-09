import { Camera } from "./camera";
import { Link, cableCost } from "./network/links";
import { StockExchangeNode, FirmNode, ProcessingPlantNode, findNextHop, type Node, type NodeEvents, type XYpoint } from "./network/nodes";
import { Packet } from "./network/packets";
import type { Firm } from "./player";
import { FONT, LINE, MONO, STATION, THEME } from "./theme";

export enum GameState {
    Start = "START",
    PlacingFirm = "PLACINGFIRM",
    SpawningExchanges = "SPAWNINGEXCHANGES",
    Playing = "PLAYING",
    ChoosingUpgrade = "CHOOSINGUPGRADE",
    PlacingPlant = "PLACINGPLANT",
}

export type UpgradeId = "cables" | "hq" | "plant";

export interface UpgradeOption {
    id: UpgradeId;
    title: string;
    description: string;
}

type SellTarget =
    | { kind: "link"; link: Link }
    | { kind: "plant"; node: ProcessingPlantNode };

//each ticker is a tradeable pair of markets; a new ticker = a new pair to connect
const SYMBOLS = ["AAPL", "BTC", "GOLD", "OIL", "ETH", "NVDA", "TSLA", "SOL"];

//how long an opportunity (its whole burst) stays tradeable, in seconds
const OPPORTUNITY_TTL = 24;
//minimum price gap before we consider spawning a trade
const MIN_SPREAD = 0.6;
//how close the cursor must be to grab or snap to a node
const NODE_HIT_RADIUS = 80;
//how far markets keep from the screen edge when they spawn, in screen pixels
const SPAWN_PADDING = 140;
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
//processing plants are bought into stock, then cost cash to actually place
const PLANT_COST = 100;
//plants run slower than the main HQ, and stay slower as processing upgrades land
const PLANT_TIME_MULTIPLIER = 1.35;

//selling refunds half of what the player paid, and needs a deliberate drag
const SELL_RATE = 0.5;
const DRAG_THRESHOLD = 8;
const SELL_BUTTON_SIZE = 68;
const SELL_BUTTON_MARGIN = 28;

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
    //plants chosen from the upgrade screen and waiting to be placed
    pendingPlants: number = 0;
    private dayTicks: number = 0;
    private spawnTimer: number = BASE_SPAWN_INTERVAL;
    private placementAfterUpgrade: boolean = false;
    private currentUpgradeChoices: UpgradeOption[] = [];

    ctx: CanvasRenderingContext2D;
    camera: Camera;
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

    //sell-by-dragging state
    sellTarget: SellTarget | null = null;
    sellHover: boolean = false;
    private pointerDownPos: XYpoint | null = null;
    private pointerDragged: boolean = false;

    private events: NodeEvents;


    constructor(player: Firm, ctx: CanvasRenderingContext2D) {
        this.elapsedTime = 0;
        this.player = player;
        this.ctx = ctx;
        this.camera = new Camera(ctx.canvas.width, ctx.canvas.height);
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
            this.ctx.save();
            this.camera.apply(this.ctx);
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
            this.ctx.restore();
            this.drawHint();
            return;
        }

        if (this.gameState === GameState.Playing) {
            this.simulate();
        }

        this.drawBackground();
        this.updatePointerState();

        //world objects are drawn through the camera, then the HUD is drawn
        //on top in plain screen space
        this.ctx.save();
        this.camera.apply(this.ctx);

        //preview cable tucks under the stations
        this.drawLinkPreview();

        for (const link of this.linkList) {
            if (link.dead && link.packetsInTransit.length === 0) continue;
            if (!link.dead) link.update();
            else link.draw();
        }

        //grey/red overlay for whatever the current sale would remove
        this.drawSellTints();

        for(const node of this.nodeList) {
            if (this.gameState === GameState.Playing) node.update(this.elapsedTime);
            node.draw(this.ctx);
        }

        this.drawSellPlantTint();
        this.drawHighlights();
        this.updateFloatingTexts();
        this.ctx.restore();

        this.drawHint();
        this.drawSellButton();
        this.drawDayBar();
        this.drawHUD();
    }

    //advances the world by one tick, but only while actually playing
    private simulate() {
        this.tick++;
        this.elapsedTime = this.tick / 60;
        this.camera.update(this.elapsedTime);
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
            this.clearSellSelection();
            this.rollUpgradeChoices();
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

    //plants share the HQ upgrades but are always a bit slower
    plantProcessingTicks(): number {
        return Math.max(16, Math.round(this.processingTicks() * PLANT_TIME_MULTIPLIER));
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

    //pick two distinct upgrades from the three available types for this day
    private rollUpgradeChoices() {
        const pool: UpgradeId[] = ["cables", "hq", "plant"];
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        this.currentUpgradeChoices = pool.slice(0, 2).map(id => this.upgradeOption(id));
    }

    private upgradeOption(id: UpgradeId): UpgradeOption {
        if (id === "cables") {
            const nextCableSpeed = 1 + CABLE_SPEED_STEP * this.cableLevel;
            return {
                id,
                title: "Faster cables",
                description: `Transit ${this.cableSpeed().toFixed(2)}x → ${nextCableSpeed.toFixed(2)}x`,
            };
        }
        if (id === "hq") {
            const nextHqTicks = Math.max(12, Math.round(BASE_PROCESSING_TICKS * Math.pow(HQ_TIME_FACTOR, this.hqLevel)));
            return {
                id,
                title: "Faster HQ",
                description: `Processing ${(this.processingTicks() / 60).toFixed(2)}s → ${(nextHqTicks / 60).toFixed(2)}s`,
            };
        }
        return {
            id,
            title: "Processing plant",
            description: `Adds 1 to stock · $${PLANT_COST} to place · ${(this.plantProcessingTicks() / 60).toFixed(2)}s/packet`,
        };
    }

    //the two upgrades offered at the end of each day
    upgradeChoices(): UpgradeOption[] {
        if (this.currentUpgradeChoices.length === 0) this.rollUpgradeChoices();
        return this.currentUpgradeChoices;
    }

    chooseUpgrade(id: UpgradeId) {
        if (this.gameState !== GameState.ChoosingUpgrade) return;

        this.currentUpgradeChoices = [];

        if (id === "cables") {
            this.cableLevel++;
            this.applyCableLevel();
        } else if (id === "hq") {
            this.hqLevel++;
            this.applyHqLevel();
        } else {
            //the plant goes into stock; the player places it and pays then
            this.pendingPlants++;
            this.placementAfterUpgrade = true;
            this.lastStartingNode = null;
            this.clearSellSelection();
            this.clearPointer();
            this.gameState = GameState.PlacingPlant;
            return;
        }

        this.startNextDay();
    }

    //enters placement mode mid-day for a plant already in stock
    beginPlantPlacement() {
        if (this.gameState !== GameState.Playing) return;
        if (this.pendingPlants <= 0) return;
        this.placementAfterUpgrade = false;
        this.lastStartingNode = null;
        this.clearSellSelection();
        this.clearPointer();
        this.gameState = GameState.PlacingPlant;
    }

    placeProcessingPlant(pos: XYpoint) {
        if (this.gameState !== GameState.PlacingPlant) return;
        if (this.pendingPlants <= 0) return;
        if (this.player.money < PLANT_COST) {
            this.pushText(`NEED $${PLANT_COST}`, pos, THEME.warning);
            return;
        }

        this.player.money -= PLANT_COST;
        this.pendingPlants--;
        const plant = new ProcessingPlantNode(pos, this.player, this.events);
        plant.processingTicks = this.plantProcessingTicks();
        plant.cost = PLANT_COST;
        this.nodeList.push(plant);
        this.pushText(`PLANT -$${PLANT_COST}`, pos, THEME.negative);

        if (this.placementAfterUpgrade) {
            this.placementAfterUpgrade = false;
            this.startNextDay();
        } else {
            this.gameState = GameState.Playing;
        }
    }

    //keeps the plant in stock and gets back to the game
    cancelPlantPlacement() {
        if (this.gameState !== GameState.PlacingPlant) return;
        const afterUpgrade = this.placementAfterUpgrade;
        this.placementAfterUpgrade = false;
        if (afterUpgrade) {
            this.startNextDay();
        } else {
            this.gameState = GameState.Playing;
        }
    }

    restart() {
        this.elapsedTime = 0;
        this.camera.reset();
        this.nodeList = [];
        this.linkList = [];
        this.floatingTexts = [];
        this.tick = 0;
        this.day = 1;
        this.cableLevel = 1;
        this.hqLevel = 1;
        this.pendingPlants = 0;
        this.dayTicks = 0;
        this.spawnTimer = BASE_SPAWN_INTERVAL;
        this.placementAfterUpgrade = false;
        this.currentUpgradeChoices = [];
        this.sellTarget = null;
        this.sellHover = false;
        this.pointerDownPos = null;
        this.pointerDragged = false;
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
        const hqTicks = this.processingTicks();
        const plantTicks = this.plantProcessingTicks();
        for (const node of this.nodeList) {
            if (node instanceof ProcessingPlantNode) {
                node.processingTicks = plantTicks;
            } else if (node instanceof FirmNode) {
                node.processingTicks = hqTicks;
            }
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
        if (this.gameState === GameState.PlacingPlant) {
            this.hoveredNode = null;
            this.linkTarget = null;
            this.linkTargetValid = false;
            this.splitTarget = null;
            this.ctx.canvas.style.cursor = 'crosshair';
            return;
        }

        this.sellHover = this.sellTarget !== null && this.mousePos !== null && this.isOverSellButton(this.mousePos);
        if (this.sellHover) {
            this.hoveredNode = null;
            this.linkTarget = null;
            this.linkTargetValid = false;
            this.splitTarget = null;
            this.ctx.canvas.style.cursor = 'pointer';
            return;
        }
        //while a sale is selected, only show cable feedback once a drag starts
        if (this.sellTarget && !this.pointerDragged) {
            this.hoveredNode = null;
            this.linkTarget = null;
            this.linkTargetValid = false;
            this.splitTarget = null;
            this.ctx.canvas.style.cursor = 'pointer';
            return;
        }
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

    //mouse events arrive in screen space; gameplay works in world space
    screenToWorld(pos: XYpoint): XYpoint {
        return this.camera.screenToWorld(pos);
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

        //only trade a pair once the player can route it via a processor:
        //source -> processor -> dest. new tickers sit idle until cabled in,
        //so they never cost reputation unfairly.
        const routable: { source: StockExchangeNode; dest: StockExchangeNode; symbol: string; processor: FirmNode }[] = [];
        for (const opp of opportunities) {
            const processor = this.findRouteProcessor(opp.source, opp.dest);
            if (processor) {
                routable.push({ source: opp.source, dest: opp.dest, symbol: opp.symbol, processor });
            }
        }
        if (routable.length === 0) return;

        const pick = routable[Math.floor(Math.random() * routable.length)];

        //a single opportunity is really a batch of share-packets: each one is
        //queued and processed at the processor one at a time, so a 98->100 move
        //only pays the spread per packet, not the whole batch at once
        const batch = BATCH_MIN + Math.floor(Math.random() * (BATCH_MAX - BATCH_MIN + 1));
        const expiresAt = this.elapsedTime + OPPORTUNITY_TTL;
        for (let i = 0; i < batch; i++) {
            const packet = new Packet(pick.source, pick.dest, pick.symbol, pick.source.price, this.elapsedTime);
            packet.expiresAt = expiresAt;
            packet.size = PACKET_SIZE;
            packet.via = pick.processor;
            pick.source.recievePackets(packet);
        }
        this.pushText(`\u00d7${batch} ${pick.symbol}`, pick.source.position, THEME.inkSoft);
    }

    //picks the processor a packet should visit. load comes first so extra
    //plants actually get used, with cable distance breaking ties.
    private findRouteProcessor(source: StockExchangeNode, dest: StockExchangeNode): FirmNode | null {
        const processors = this.nodeList.filter(
            (node): node is FirmNode => node instanceof FirmNode
        );

        let best: FirmNode | null = null;
        let bestScore = Infinity;
        for (const processor of processors) {
            if (findNextHop(source, processor) === null) continue;
            if (findNextHop(processor, dest) === null) continue;

            const distance =
                Math.hypot(source.position.x - processor.position.x, source.position.y - processor.position.y) +
                Math.hypot(dest.position.x - processor.position.x, dest.position.y - processor.position.y);
            const score = processor.queuedCount() * 150 + distance;

            if (score < bestScore) {
                bestScore = score;
                best = processor;
            }
        }
        return best;
    }

    getRandomXYpoint(): XYpoint {
        //markets spawn inside whatever the camera can currently see, inset by
        //a fixed amount of screen space so they never sit under the HUD/edge
        const rect = this.camera.visibleRect();
        const pad = SPAWN_PADDING / this.camera.zoom;
        const innerWidth = Math.max(1, rect.width - pad * 2);
        const innerHeight = Math.max(1, rect.height - pad * 2);

        let fallback: XYpoint = { x: rect.x + pad, y: rect.y + pad };
        for (let attempt = 0; attempt < 30; attempt++) {
            const point = {
                x: rect.x + pad + Math.random() * innerWidth,
                y: rect.y + pad + Math.random() * innerHeight,
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
        this.pointerDownPos = { x: pos.x, y: pos.y };
        this.pointerDragged = false;

        //clicking the bin sells the current selection instead of starting a drag
        if (this.sellTarget && this.isOverSellButton(pos)) {
            this.sellHover = true;
            return;
        }

        const startNode = this.getNodeAtPosition(pos, NODE_HIT_RADIUS);
        const hitLink = startNode ? null : this.findLinkAt(pos);

        //a processing plant is sellable, but still acts as a cable start point
        //so the player can drag from it as before
        if (startNode instanceof ProcessingPlantNode) {
            this.sellTarget = { kind: "plant", node: startNode };
            this.sellHover = false;
            this.lastStartingNode = startNode;
            return;
        }
        if (hitLink) {
            this.sellTarget = { kind: "link", link: hitLink };
            this.sellHover = false;
            this.lastStartingNode = null;
            this.editingLink = hitLink;
            this.editHandlePos = { x: pos.x, y: pos.y };
            this.editSplitTarget = null;
            hitLink.fading = true;
            return;
        }

        //anything else drops the selection
        this.clearSellSelection();
        this.pointerDownPos = { x: pos.x, y: pos.y };

        if (startNode) {
            this.lastStartingNode = startNode;
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
        if (this.pointerDownPos) {
            const dist = Math.hypot(pos.x - this.pointerDownPos.x, pos.y - this.pointerDownPos.y);
            if (dist > DRAG_THRESHOLD) this.pointerDragged = true;
        }
        this.sellHover = this.sellTarget !== null && this.isOverSellButton(pos);
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
        this.sellHover = false;
        this.pointerDownPos = null;
        this.pointerDragged = false;
        this.cancelEdit();
        this.ctx.canvas.style.cursor = 'default';
    }

    //----- selling -----

    //the bin sits centred at the bottom of the canvas
    private sellButtonRect(): { x: number, y: number, size: number } {
        const size = SELL_BUTTON_SIZE;
        return {
            x: (this.ctx.canvas.width - size) / 2,
            y: this.ctx.canvas.height - SELL_BUTTON_MARGIN - size,
            size,
        };
    }

    private isOverSellButton(pos: XYpoint): boolean {
        //the bin is screen-space UI, so map the world pointer back first
        const screen = this.camera.worldToScreen(pos);
        const rect = this.sellButtonRect();
        const pad = 10;
        return screen.x >= rect.x - pad && screen.x <= rect.x + rect.size + pad &&
            screen.y >= rect.y - pad && screen.y <= rect.y + rect.size + pad;
    }

    //everything that would go if the current selection were sold
    private sellLinks(target: SellTarget | null = this.sellTarget): Link[] {
        if (!target) return [];
        if (target.kind === "link") return target.link.dead ? [] : [target.link];
        if (!this.nodeList.includes(target.node)) return [];
        return this.linkList.filter(link => link.a === target.node || link.b === target.node);
    }

    private sellValueFor(target: SellTarget | null = this.sellTarget): number {
        if (!target) return 0;
        let value = 0;
        if (target.kind === "plant") value += target.node.cost * SELL_RATE;
        for (const link of this.sellLinks(target)) value += link.cost * SELL_RATE;
        return value;
    }

    private removeLinkForSale(link: Link) {
        if (link.dead) return;
        link.dead = true;
        link.fading = true;
        //packets riding the cable are lost without a reputation hit
        link.packetsInTransit.length = 0;
        this.linkList = this.linkList.filter(item => item !== link);
        link.a.links = link.a.links.filter(item => item !== link);
        link.b.links = link.b.links.filter(item => item !== link);
    }

    clearSellSelection() {
        this.sellTarget = null;
        this.sellHover = false;
        this.pointerDownPos = null;
        this.pointerDragged = false;
    }

    private sellSelected() {
        const target = this.sellTarget;
        if (!target) return;

        //a sold item can still be the active drag/edit anchor
        this.cancelEdit();
        this.splitTarget = null;
        this.lastStartingNode = null;

        const links = this.sellLinks(target);
        const refund = this.sellValueFor(target);
        const pos = target.kind === "link"
            ? {
                x: (target.link.a.position.x + target.link.b.position.x) / 2,
                y: (target.link.a.position.y + target.link.b.position.y) / 2,
            }
            : target.node.position;

        for (const link of links) {
            this.removeLinkForSale(link);
        }

        if (target.kind === "plant") {
            const plant = target.node;
            //packets already routed to this plant go to another processor,
            //preferring the permanent HQ
            const replacement =
                this.nodeList.find((node): node is FirmNode => node instanceof FirmNode && !(node instanceof ProcessingPlantNode) && node !== plant) ??
                this.nodeList.find((node): node is FirmNode => node instanceof FirmNode && node !== plant) ??
                null;
            for (const node of this.nodeList) {
                if (node === plant) continue;
                node.retargetPackets(plant, replacement);
            }
            //packets already riding a cable toward the plant also need a new target
            for (const link of this.linkList) {
                for (const transit of link.packetsInTransit) {
                    if (transit.packet.via === plant) transit.packet.via = replacement;
                }
            }
            //anything still queued at the plant is dropped with it
            plant.packetQueue.length = 0;
            this.nodeList = this.nodeList.filter(node => node !== plant);
        }

        this.player.money += refund;
        this.pushText(`+$${refund.toFixed(2)}`, pos, THEME.positive);
        this.clearSellSelection();
    }

    //red/ grey out everything that would be sold
    private drawSellTints() {
        if (!this.sellTarget) return;
        const color = this.sellHover ? THEME.negative : THEME.inkSoft;
        const alpha = this.sellHover ? 0.6 : 0.28;
        for (const link of this.sellLinks()) {
            link.drawSellTint(this.ctx, color, alpha);
        }
    }

    //the plant itself is drawn over the stations so the tint stays visible
    private drawSellPlantTint() {
        if (!this.sellTarget || this.sellTarget.kind !== "plant") return;
        const color = this.sellHover ? THEME.negative : THEME.inkSoft;
        const alpha = this.sellHover ? 0.6 : 0.28;
        const node = this.sellTarget.node;
        const half = STATION.hqSize / 2;
        this.ctx.save();
        this.ctx.globalAlpha = alpha;
        this.ctx.fillStyle = color;
        this.ctx.beginPath();
        this.ctx.roundRect(node.position.x - half, node.position.y - half, STATION.hqSize, STATION.hqSize, 10);
        this.ctx.fill();
        this.ctx.restore();
    }

    private drawSellButton() {
        if (!this.sellTarget) return;
        const rect = this.sellButtonRect();
        const cx = rect.x + rect.size / 2;
        const cy = rect.y + rect.size / 2;
        const active = this.sellHover;

        this.ctx.save();
        this.ctx.shadowColor = 'rgba(47, 42, 38, 0.22)';
        this.ctx.shadowBlur = 18;
        this.ctx.shadowOffsetY = 6;
        this.ctx.beginPath();
        this.ctx.roundRect(rect.x, rect.y, rect.size, rect.size, 16);
        this.ctx.fillStyle = active ? THEME.negative : THEME.ink;
        this.ctx.fill();
        this.ctx.restore();

        //simple bin icon
        this.ctx.save();
        this.ctx.strokeStyle = THEME.hqText;
        this.ctx.fillStyle = THEME.hqText;
        this.ctx.lineWidth = 3;
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';
        this.ctx.beginPath();
        this.ctx.moveTo(cx - 13, cy - 12);
        this.ctx.lineTo(cx + 13, cy - 12);
        this.ctx.stroke();
        this.ctx.beginPath();
        this.ctx.moveTo(cx - 7, cy - 12);
        this.ctx.lineTo(cx - 6, cy - 18);
        this.ctx.lineTo(cx + 6, cy - 18);
        this.ctx.lineTo(cx + 7, cy - 12);
        this.ctx.stroke();
        this.ctx.beginPath();
        this.ctx.roundRect(cx - 11, cy - 8, 22, 26, 4);
        this.ctx.stroke();
        this.ctx.beginPath();
        this.ctx.moveTo(cx - 4, cy - 3);
        this.ctx.lineTo(cx - 3, cy + 13);
        this.ctx.moveTo(cx + 4, cy - 3);
        this.ctx.lineTo(cx + 3, cy + 13);
        this.ctx.stroke();
        this.ctx.restore();

        //refund preview
        const refund = this.sellValueFor();
        this.ctx.save();
        this.ctx.textAlign = 'center';
        this.ctx.font = `bold 22px ${MONO}`;
        this.ctx.fillStyle = active ? THEME.negative : THEME.ink;
        this.ctx.fillText(`+$${refund.toFixed(2)}`, cx, rect.y - 16);
        this.ctx.restore();
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
        const dragged = this.pointerDragged;

        //release over the bin sells, whether it was a drag or a plain click
        if (this.sellTarget && this.isOverSellButton(pos)) {
            this.sellSelected();
            this.pointerDownPos = null;
            this.pointerDragged = false;
            return null;
        }

        const result = this.placeLinkAction(pos);
        this.pointerDownPos = null;
        this.pointerDragged = false;
        this.sellHover = false;
        //a real drag was a cable/split action, so drop the selection
        if (dragged) this.clearSellSelection();
        return result;
    }

    private placeLinkAction(pos: XYpoint) {
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
        if (this.sellHover) return;
        if (this.sellTarget && !this.pointerDragged) return;
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
        if (this.sellHover) return;
        if (this.sellTarget && !this.pointerDragged) return;
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
        if (this.gameState === GameState.PlacingPlant) {
            this.ctx.save();
            this.ctx.textAlign = 'center';
            this.ctx.fillStyle = THEME.ink;
            this.ctx.font = `28px ${FONT}`;
            this.ctx.fillText(
                `Click anywhere to place a processing plant ($${PLANT_COST})`,
                this.ctx.canvas.width / 2,
                this.ctx.canvas.height / 2,
            );
            this.ctx.fillStyle = THEME.inkSoft;
            this.ctx.font = `18px ${FONT}`;
            this.ctx.fillText(
                'Esc to keep it in stock',
                this.ctx.canvas.width / 2,
                this.ctx.canvas.height / 2 + 38,
            );
            this.ctx.restore();
            return;
        }
        if (this.sellTarget) return;
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

        let hudY = 212;
        const plantCount = this.nodeList.filter(node => node instanceof ProcessingPlantNode).length;
        if (plantCount > 0) {
            this.ctx.fillText(`Plants ${plantCount} · ${(this.plantProcessingTicks() / 60).toFixed(2)}s`, 42, hudY);
            hudY += 24;
        }
        if (this.pendingPlants > 0) {
            this.ctx.fillStyle = THEME.warning;
            this.ctx.fillText(`Plant in stock ${this.pendingPlants} · $${PLANT_COST} to place`, 42, hudY);
        }
    }
}
