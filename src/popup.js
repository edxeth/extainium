import { trackedView } from "./lib/manager.js";

const $ = (id) => document.getElementById(id);

async function render() {
  const view = await trackedView();
  const updates = view.filter((v) => v.state === "update");
  $("summary").textContent = !view.length
    ? "No tracked extensions"
    : updates.length
      ? `${updates.length} update${updates.length > 1 ? "s" : ""} available`
      : `All ${view.length} up to date`;
  $("updates").replaceChildren(
    ...updates.map((v) => {
      const li = document.createElement("li");
      li.textContent = `${v.ext ? v.ext.name : v.key}: ${v.ext.version} → ${v.latest.tag}`;
      return li;
    })
  );
  const { lastCheck } = await chrome.storage.local.get("lastCheck");
  $("lastCheck").textContent = lastCheck ? "Last check: " + new Date(lastCheck.at).toLocaleString() : "Not checked yet";
}

$("check").addEventListener("click", async () => {
  $("check").disabled = true;
  $("check").textContent = "Checking…";
  const res = await chrome.runtime.sendMessage({ type: "check" });
  const errors = res.error ? [res.error] : res.errors;
  $("error").hidden = !errors.length;
  $("error").textContent = errors.join("\n");
  $("check").disabled = false;
  $("check").textContent = "Check now";
  await render();
});

$("open").addEventListener("click", () => chrome.runtime.openOptionsPage());

render();
