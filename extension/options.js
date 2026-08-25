const checkbox = document.getElementById("pii-strict");
const saved = document.getElementById("saved");

chrome.storage.local.get("piiStrict").then(({ piiStrict }) => {
  checkbox.checked = !!piiStrict;
});

checkbox.addEventListener("change", async () => {
  await chrome.storage.local.set({ piiStrict: checkbox.checked });
  saved.textContent = "Saved.";
  setTimeout(() => (saved.textContent = ""), 1500);
});
