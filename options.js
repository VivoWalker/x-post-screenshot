const shortcutElement = document.getElementById("current-shortcut");
const statusElement = document.getElementById("shortcut-status");
const openButton = document.getElementById("open-shortcuts");
const hintElement = document.getElementById("shortcut-hint");
const firefoxShortcuts = typeof chrome.commands.openShortcutSettings === "function";

hintElement.textContent = firefoxShortcuts
  ? "Firefox 会在扩展快捷键页面中保存设置。修改后返回本页即可看到新快捷键。"
  : "Chrome 会在扩展快捷键页面中保存设置。修改后返回本页即可看到新快捷键。";

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
  if (firefoxShortcuts) {
    await chrome.commands.openShortcutSettings();
  } else {
    await chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  }
});

window.addEventListener("focus", refreshShortcut);
refreshShortcut();
