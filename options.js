// options.js
function openOptions() {
    window.open("options.html", "_blank", "width=400,height=300");
}

function closeModal() {
    document.getElementById("optionsModal").style.display = "none";
}

function openModal() {
    document.getElementById("optionsModal").style.display = "block";
}

document.getElementById('downloadHistory').addEventListener('click', () => {
  chrome.storage.local.get(['peertubeWatchHistory'], (result) => {
    const history = result.peertubeWatchHistory || {};
    const blob = new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = 'peertubeWatchHistory.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
});

document.addEventListener('DOMContentLoaded', () => {
  const nsfwToggle = document.getElementById('nsfw-toggle');

  // Load saved setting
  chrome.storage.local.get(['filterMode'], (result) => {
    if (result.filterMode) {
      nsfwToggle.value = result.filterMode;
    }
  });

  // Save new setting on change
  nsfwToggle.addEventListener('change', function() {
    const filterMode = this.value;
    chrome.storage.local.set({ filterMode });
    // Optionally re-fetch/render content if needed here
  });
});
// Handle button click to open file chooser
document.getElementById('uploadHistory').addEventListener('click', () => {
  document.getElementById('uploadFileInput').click();
});

// Handle file selection and parse JSON
document.getElementById('uploadFileInput').addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = JSON.parse(e.target.result);
      chrome.storage.local.set({ peertubeWatchHistory: data }, () => {
        alert('Watch history successfully uploaded.');
      });
    } catch (err) {
      alert('Invalid JSON file.');
      console.error(err);
    }
  };
  reader.readAsText(file);
});
document.getElementById('deleteHistory').addEventListener('click', () => {
  if (confirm('Are you sure you want to delete your PeerTube watch history? This action cannot be undone.')) {
    chrome.storage.local.remove('peertubeWatchHistory', () => {
      alert('Watch history deleted.');
    });
  }
});
