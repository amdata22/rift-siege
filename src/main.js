import { RiftSiegeGame } from "./game.js";

const app = document.querySelector("#app");
const bootStatus = document.querySelector("#bootStatus");

function setBootStatus(text) {
  if (bootStatus) bootStatus.textContent = text;
}

function showFatalError(message) {
  setBootStatus("Startup failed.");
  const panel = document.createElement("div");
  panel.style.position = "fixed";
  panel.style.inset = "16px";
  panel.style.padding = "14px";
  panel.style.background = "rgba(25, 0, 0, 0.9)";
  panel.style.border = "1px solid rgba(255, 70, 70, 0.55)";
  panel.style.color = "#ffdede";
  panel.style.fontFamily = "monospace";
  panel.style.fontSize = "13px";
  panel.style.zIndex = "9999";
  panel.style.whiteSpace = "pre-wrap";
  panel.textContent = `Fatal startup error:\n${message}`;
  document.body.appendChild(panel);
}

window.addEventListener("error", (event) => {
  showFatalError(event.error?.stack || event.message || "Unknown error");
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason?.stack || String(event.reason || "Unknown rejection");
  showFatalError(reason);
});

if (!app) {
  showFatalError("Cannot find #app mount node in index.html");
} else {
  setBootStatus("Initializing renderer...");
  const game = new RiftSiegeGame(app);
  game
    .init()
    .then(() => {
      setBootStatus("Init complete. If black, click once and check for menu.");
      setTimeout(() => {
        if (bootStatus) {
          bootStatus.remove();
        }
      }, 2500);
    })
    .catch((err) => {
      showFatalError(err?.stack || String(err));
    });
}
