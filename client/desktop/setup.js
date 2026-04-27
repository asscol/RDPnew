const urlInput = document.getElementById("url");
const errEl = document.getElementById("err");

window.api.loadConfig().then((cfg) => {
  if (cfg && cfg.serverUrl) urlInput.value = cfg.serverUrl;
});

document.getElementById("save").addEventListener("click", async () => {
  const r = await window.api.saveServer(urlInput.value);
  if (r.error) {
    errEl.textContent = "Invalid URL — please enter a full http(s) URL.";
    return;
  }
  window.close();
});

document.getElementById("cancel").addEventListener("click", () => window.close());

urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("save").click();
});
