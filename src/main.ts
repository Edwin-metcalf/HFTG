import './style.css'
import { Renderer } from './renderer'
import { Firm } from './player'
import { GameManager } from './gameManager'
import type { XYpoint } from './network/nodes'

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<div class="stage">
  <canvas tabindex="0" id="canvas" width="1920" height="1080"></canvas>
  <div id="startOverlay" class="overlay start-overlay">
    <div class="panel start-panel">
      <h1 class="start-title">HFTG</h1>
      <p class="start-desc">Build a high-frequency trading network. Place your firm, connect nodes, and route packets to capture trading opportunities.</p>
      <button id="playBtn" class="play-btn" type="button">Play</button>
      <p class="start-hint">Press Enter or Space to play</p>
    </div>
  </div>
  <div id="overlay" class="overlay hidden">
    <div class="panel">
      <h2>Choose one upgrade</h2>
      <div id="overlayChoices" class="choices"></div>
    </div>
  </div>
</div>
`
function init() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    console.log("canvas context broke")
    return
  }

  canvas.style.display = 'none';

  const startOverlay = document.getElementById('startOverlay') as HTMLDivElement;
  const playBtn = document.getElementById('playBtn') as HTMLButtonElement;
  const overlay = document.getElementById('overlay') as HTMLDivElement;
  const overlayChoices = document.getElementById('overlayChoices') as HTMLDivElement;

  const player = new Firm();
  const gameManager = new GameManager(player, ctx);
  new Renderer(ctx);

  function startGame() {
    startOverlay.classList.add('hidden');
    canvas.style.display = 'block';
    gameManager.gameState = "PLACINGFIRM" as any;
    canvas.focus();
    gameManager.pushText('Click anywhere to place your HQ', { x: canvas.width / 2, y: canvas.height / 2 }, '#2f2a26');
  }

  playBtn.addEventListener('click', startGame);
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if ((e.key === 'Enter' || e.key === ' ') && startOverlay.classList.contains('hidden') === false) {
      e.preventDefault();
      startGame();
    }
  });

  //remember which day the open overlay belongs to so we only build it once
  let overlayDay = -1;

  function renderOverlay() {
    if (gameManager.gameState !== "CHOOSINGUPGRADE") {
      overlay.classList.add('hidden');
      return;
    }

    if (overlayDay === gameManager.day) return;
    overlayDay = gameManager.day;

    overlayChoices.innerHTML = '';
    for (const option of gameManager.upgradeChoices()) {
      const button = document.createElement('button');
      button.className = 'choice';
      button.type = 'button';

      const title = document.createElement('strong');
      title.textContent = option.title;
      const detail = document.createElement('span');
      detail.textContent = option.description;

      button.append(title, detail);
      button.addEventListener('click', () => {
        gameManager.chooseUpgrade(option.id);
        overlayDay = -1;
        renderOverlay();
      });
      overlayChoices.appendChild(button);
    }
    overlay.classList.remove('hidden');
  }

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
      gameManager.placeFirmNode(point);
    } else {
      //this will need states cause mousedown cant always do the same thing
      gameManager.startLink(point)
    }
  });

  canvas.addEventListener('mousemove', (e: MouseEvent) => {
    const point = getCanvasPos(e);

    gameManager.placingLink(point)

  });

  canvas.addEventListener('mouseleave', () => {
    gameManager.clearPointer();
  });

  canvas.addEventListener('mouseup', (e: MouseEvent) => {
    const point = getCanvasPos(e);

    gameManager.placeLink(point)
  });
  canvas.addEventListener('tick', () => {
    gameManager.update();
    renderOverlay();
  });
}
init();
