interface TickEventDetail {
    frameCount: number;
    frameSkip: number;
}

type TickEvent = CustomEvent<TickEventDetail>;

export class Renderer {
    ctx: CanvasRenderingContext2D;
    fps: number;
    counter: number;
    oldTimeStamp: number;
    tickEvent: TickEvent | null;


    constructor(ctx: CanvasRenderingContext2D) {
        this.ctx = ctx;
        this.fps = 60;//try to get 60
        this.counter = 0;
        this.oldTimeStamp = 0;
        this.initTicker();
        this.tickEvent = null;

    }

    private initTicker() {
        window.requestAnimationFrame(() => {
            this.tick();
            this.initTicker();
        });
    }

    private tick() {
        const timeStamp = performance.now();
        const secondsPassed = (timeStamp - this.oldTimeStamp) / 1000;
        this.oldTimeStamp = timeStamp;

        const fps = Math.round(1 / secondsPassed);
        const clamp = (val: number, min: number, max: number) => Math.min(Math.max(val,min), max);
        const frameSkip = clamp(Math.round((60 - fps) / fps), 0, 30);

        //setting up for if we need an animation of up to 1s
        if (this.counter >= this.fps * 2) {
            this.counter = 0;
        }
        const tick: TickEvent = new CustomEvent("tick", {
            bubbles: true,
            cancelable: true,
            composed: false,
            detail: {
                frameCount: this.counter,
                frameSkip: frameSkip,
            },
        });
        this.ctx.clearRect(0,0, this.ctx.canvas.width, this.ctx.canvas.height);
        this.ctx.canvas.dispatchEvent(tick);
        this.counter++;

    }
    
}