const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const destination = path.resolve(process.argv[2] || path.join(root, "dist", "firefox"));
if (destination.toLowerCase() === root.toLowerCase()) {
  throw new Error("不能覆盖 Chrome 开发目录中的 manifest.json");
}

const files = [
  "png-stitch.js",
  "firefox-background.js",
  "content.js",
  "content.css",
  "options.html",
  "options.js",
  "options.css"
];

fs.mkdirSync(destination, { recursive: true });
for (const file of files) {
  fs.copyFileSync(path.join(root, file), path.join(destination, file));
}
fs.copyFileSync(path.join(root, "manifest.firefox.json"), path.join(destination, "manifest.json"));
process.stdout.write(`Firefox 扩展目录：${destination}\n`);
