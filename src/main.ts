import './style.css'
import { Renderer } from './renderer'
import { Firm } from './player'
import { GameManager, GameState } from './gameManager'
import { FirmNode } from './network/nodes'
import type { XYpoint } from './network/nodes'

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<div class="loader">
  <progress value="0" max="100"></progress>
</div>

<canvas tabindex="0" id="canvas" width="1920" height="1080"></canvas>
`
function init() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    console.log("canvas context broke")
    return
  }


  const player = new Firm();
  const gameManager = new GameManager(player, ctx);
  const renderer = new Renderer(ctx);

  function getCanvasPos(e: MouseEvent): XYpoint {
    //this is a helper function that is needed to correctly get the mouse position
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY,
    }
  }

  canvas.addEventListener('mousedown', (e: MouseEvent) => {
    //these make sure its the correct location on the screen relative to canvas on page
    const point = getCanvasPos(e);

    if (gameManager.gameState === "PLACINGFIRM") {
      let firmNode = new FirmNode(point, player);
      gameManager.nodeList.push(firmNode);
      gameManager.gameState = GameState.Playing;
    } else {
      //this will need states cause mousedown cant always do the same thing
      gameManager.startLink(point)
    }
  });

  canvas.addEventListener('mousemove', (e: MouseEvent) => {
    const point = getCanvasPos(e);

    gameManager.placingLink(point)

  });

  canvas.addEventListener('mouseup', (e: MouseEvent) => {
    const point = getCanvasPos(e);

    gameManager.placeLink(point)
  });
  canvas.addEventListener('tick', (e: Event) => {
    const tickEvent = e as CustomEvent<{ frameCount: number; frameSkip: number }>;
    gameManager.update(tickEvent.detail.frameCount);

  });
}
init();