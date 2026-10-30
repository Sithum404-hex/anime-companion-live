const puppeteer = require("puppeteer-core");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    headless: "new",
    args: [
      "--no-sandbox",
      "--enable-unsafe-swiftshader",
      "--disable-dev-shm-usage",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => console.log("  [PAGEERR]", String(e).slice(0, 200)));

  // Must be set before the app boots or AuthGate bounces us to /auth.
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem("waifu.auth.v1", JSON.stringify({ mode: "guest" }));
    localStorage.setItem("waifu.chatHistory.v2", "[]");
    navigator.mediaDevices.getDisplayMedia = async () => {
      const c = document.createElement("canvas");
      c.width = 640;
      c.height = 360;
      const g = c.getContext("2d");
      const paint = () => {
        g.fillStyle = "#0b1a2b";
        g.fillRect(0, 0, 640, 360);
        g.fillStyle = "#8cf";
        g.font = "32px sans-serif";
        g.fillText("VS Code — liveMode.ts", 40, 180);
      };
      paint();
      setInterval(paint, 200);
      return c.captureStream(5);
    };
  });

  await page.goto("http://localhost:8080/", { waitUntil: "networkidle2", timeout: 90000 });
  await sleep(16000);
  await page.mouse.move(700, 400);
  await sleep(800);

  const glass = await page.evaluate(() => {
    const dock = document.querySelector(".glass");
    const cs = dock ? getComputedStyle(dock) : null;
    return {
      url: location.pathname,
      glass: !!dock,
      backdrop: cs?.backdropFilter,
      segThumb: !!document.querySelector(".seg-thumb"),
      petals: document.querySelectorAll(".petal").length,
      tabs: [...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent.trim()),
    };
  });
  console.log("GLASS:", JSON.stringify(glass));

  // Chat
  await page.click("input");
  await page.type("input", "hello waifu! how are you?", { delay: 12 });
  await page.keyboard.press("Enter");
  for (let i = 0; i < 20; i++) {
    await sleep(2500);
    const done = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("waifu.chatHistory.v2") || "[]").some(
        (m) => m.role === "assistant",
      ),
    );
    if (done) break;
  }
  console.log(
    "CHAT:",
    await page.evaluate(() => {
      const h = JSON.parse(localStorage.getItem("waifu.chatHistory.v2") || "[]");
      return h
        .filter((m) => m.role === "assistant")
        .pop()
        ?.content.slice(0, 110);
    }),
  );

  // Screen mode -> should start capture and auto-comment
  await page.evaluate(() =>
    [...document.querySelectorAll('[role="tab"]')]
      .find((b) => b.textContent.trim() === "Screen")
      ?.click(),
  );
  await sleep(20000);
  console.log(
    "SCREEN:",
    JSON.stringify(
      await page.evaluate(() => ({
        pill:
          document.body.innerText.includes("Read now") ||
          document.body.innerText.includes("Reading"),
        replies: JSON.parse(localStorage.getItem("waifu.chatHistory.v2") || "[]").filter(
          (m) => m.role === "assistant",
        ).length,
      })),
    ),
  );

  // Live mode -> dock swaps to PTT
  await page.evaluate(() =>
    [...document.querySelectorAll('[role="tab"]')]
      .find((b) => b.textContent.trim() === "Live")
      ?.click(),
  );
  await sleep(2500);
  console.log(
    "LIVE:",
    JSON.stringify(
      await page.evaluate(() => ({
        chatInputGone: !document.querySelector("input"),
        ptt: !!document.querySelector('button[aria-label="Hold to talk"]'),
        state: document.body.innerText.match(
          /Ready — hold to talk|Listening|Thinking|Speaking/,
        )?.[0],
      })),
    ),
  );

  // Settings
  await page.evaluate(() =>
    [...document.querySelectorAll('[role="tab"]')]
      .find((b) => b.textContent.trim() === "Chat")
      ?.click(),
  );
  await sleep(800);
  await page.evaluate(() => document.querySelector('button[aria-label="Open settings"]')?.click());
  await sleep(1800);
  console.log(
    "SETTINGS:",
    JSON.stringify(
      await page.evaluate(() => ({
        glassScope: !!document.querySelector(".glass-ui"),
        tiles: document.querySelectorAll(".opt-tile").length,
        selectedTiles: document.querySelectorAll('.opt-tile[data-selected="true"]').length,
        switches: document.querySelectorAll('[role="switch"]').length,
        wells: document.querySelectorAll(".glass--well").length,
      })),
    ),
  );
  await page.screenshot({ path: "final-settings.png" });
  await page.evaluate(() => document.querySelector('button[aria-label="Close settings"]')?.click());
  await sleep(800);
  await page.screenshot({ path: "final-main.png" });

  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
