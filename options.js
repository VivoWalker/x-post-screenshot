const shortcutElement = document.getElementById("current-shortcut");
const statusElement = document.getElementById("shortcut-status");
const openButton = document.getElementById("open-shortcuts");

async function refreshShortcut() {
  try {
    const commands = await chrome.commands.getAll();
    const captureCommand = commands.find((command) => command.name === "start-capture");
    const shortcut = captureCommand?.shortcut || "";

    shortcutElement.textContent = shortcut || "未设置";
    shortcutElement.classList.toggle("unassigned", !shortcut);
    statusElement.textContent = shortcut
      ? ""
      : "当前没有绑定快捷键，请点击下方按钮进行设置。";
  } catch (error) {
    shortcutElement.textContent = "读取失败";
    shortcutElement.classList.add("unassigned");
    statusElement.textContent = error?.message || String(error);
  }
}

openButton.addEventListener("click", async () => {
  await chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

window.addEventListener("focus", refreshShortcut);
refreshShortcut();
