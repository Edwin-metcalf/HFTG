import type { XYpoint } from "./network/nodes";

//the world is the canvas coordinate space at zoom 1. the camera slowly pulls
//back over a run so more of the world becomes visible as the network grows.
const ZOOM_TIME_SECONDS = 500;
//numeric guard only: the curve approaches zero but never reaches it, so the
//zoom is effectively endless.
const ZOOM_FLOOR = 1e-3;

export interface WorldRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export class Camera {
    zoom: number = 1;

    private width: number;
    private height: number;

    constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
    }

    get centerX(): number {
        return this.width / 2;
    }

    get centerY(): number {
        return this.height / 2;
    }

    //endless, slow zoom-out. after ~4 minutes the view shows twice the
    //distance, and it keeps shrinking from there.
    update(elapsedSeconds: number): void {
        this.zoom = Math.max(ZOOM_FLOOR, 1 / (1 + elapsedSeconds / ZOOM_TIME_SECONDS));
    }

    reset(): void {
        this.zoom = 1;
    }

    //maps world coordinates into the visible canvas
    apply(ctx: CanvasRenderingContext2D): void {
        ctx.translate(this.centerX, this.centerY);
        ctx.scale(this.zoom, this.zoom);
        ctx.translate(-this.centerX, -this.centerY);
    }

    screenToWorld(pos: XYpoint): XYpoint {
        return {
            x: (pos.x - this.centerX) / this.zoom + this.centerX,
            y: (pos.y - this.centerY) / this.zoom + this.centerY,
        };
    }

    worldToScreen(pos: XYpoint): XYpoint {
        return {
            x: (pos.x - this.centerX) * this.zoom + this.centerX,
            y: (pos.y - this.centerY) * this.zoom + this.centerY,
        };
    }

    //the slice of the world currently on screen, used for spawn positions
    visibleRect(): WorldRect {
        const halfWidth = this.centerX / this.zoom;
        const halfHeight = this.centerY / this.zoom;
        return {
            x: this.centerX - halfWidth,
            y: this.centerY - halfHeight,
            width: halfWidth * 2,
            height: halfHeight * 2,
        };
    }
}
