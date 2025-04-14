chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'manualExport' || message.action === 'autoExport') {
        const historyData = message.data;
        saveDataToJsonFile(JSON.parse(historyData), 'peertube_watch_history.json');
    }
});

function saveDataToJsonFile(data, filename = 'data.json') {
    const jsonString = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const reader = new FileReader();

    reader.onload = function(event) {
        chrome.downloads.download({
            url: event.target.result,
            filename: filename,
            saveAs: true
        }, function(downloadId) {
            if (downloadId === undefined) {
                console.error("Download failed:", chrome.runtime.lastError);
            } else {
                console.log("Download started with ID:", downloadId);
            }
        });
    };
    reader.readAsDataURL(blob);
}
