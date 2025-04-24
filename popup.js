document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("open-similarity").addEventListener("click", () => {
    chrome.tabs.create({
      url: chrome.runtime.getURL("cosine_similarity.html")
    });
  });
});
