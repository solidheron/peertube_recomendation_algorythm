// content.js

// Global variables
let currentSession = null;
let ctrlPressed = false;
let shiftPressed = false;
let lastSaveTime = 0;
const interval = 1; // interval in seconds

// Initialize variables
let currentURL = window.location.href;  // Initialize currentURL
let data = null; // Initialize data as null
let prev = []; // Initialize as empty array

// Function to initialize or reset data
function initializeData() {
    return {
        title: document.title,
        url: currentURL,
        currentTime: 0,
        duration: 0,
        percentWatched: 0,
        watchedLiveSeconds: 0,  // For live streams - in seconds
        isLive: false,
        liked: false,
        disliked: false,
        last_update: new Date().toISOString(),
        session: {
            segments: []
        },
        sessionStart: null,
        finished: false
    };
}

// Function to load watch history and initialize data for current video
function loadWatchHistory(callback) {
    chrome.storage.local.get(['peertubeWatchHistory'], (result) => {
        if (result.peertubeWatchHistory) {
            try {
                prev = JSON.parse(result.peertubeWatchHistory);
                if (!Array.isArray(prev)) {
                    prev = []; // Ensure it's an array
                }

                console.log('Watch history loaded from storage:', prev);

                // Find existing data for current URL
                const existingData = prev.find(item => item.url === currentURL);
                if (existingData) {
                    console.log('Found existing data for current URL:', existingData);
                    data = existingData; // Use existing data
                } else {
                    // Initialize fresh data for new URL
                    data = initializeData();
                    // Add the new data to the prev array
                    prev.push(data);
                    console.log('No existing data found for current URL. Initializing fresh data and adding to array.');
                }
            } catch (e) {
                console.error('Error parsing watch history:', e);
                prev = []; // Reset to empty array in case of parsing error
                data = initializeData(); // Ensure data is initialized
                prev.push(data); // Add the new data to the prev array
            }
        } else {
            prev = []; // If no data in storage, start with an empty array
            data = initializeData(); // Ensure data is initialized
            prev.push(data); // Add the new data to the prev array
            console.log('No watch history found in storage. Initializing fresh data and adding to array.');
        }

        // Call the main function after loading the watch history.
        main();

        callback(); // Call the callback function after loading
    });
}


// --- URL CHANGE DETECTION ---
let lastURL = window.location.href;

setInterval(() => {
    if (window.location.href !== lastURL) {
        console.log("URL changed from", lastURL, "to", window.location.href);
        lastURL = window.location.href;
        currentURL = window.location.href; // Update currentURL

        // Re-initialize data for the new URL
        data = initializeData();
        
        // Add the new data to the prev array if it doesn't exist
        const existingIndex = prev.findIndex(item => item.url === currentURL);
        if (existingIndex === -1) {
            prev.push(data);
        }
        
        loadWatchHistory(() => {
            console.log("Watch history loaded/reloaded after URL change.");
        });
    }
}, 1000);

// --- END URL CHANGE DETECTION ---

// Load watch history and then execute main logic
loadWatchHistory(() => {
    console.log("Initial watch history loaded.");
});

// Variable to store the previous current time for regular videos
let previousCurrentTime = 0;

// Variable to track if the video is playing
let isVideoPlaying = false;

// Performance monitoring variables
let executionTimes = [];

// Function to fetch PeerTube video info synchronously using its API
function fetchVideoInfoSync(videoUrl) {
    try {
        const videoIdMatch = videoUrl.match(/(?:\/videos\/watch\/|\/w\/)([a-zA-Z0-9\-_]+)/);
        if (!videoIdMatch) {
            console.warn("❌ Could not extract video ID from URL:", videoUrl);
            return null;
        }

        const videoId = videoIdMatch[1];
        const apiUrl = `${window.location.origin}/api/v1/videos/${videoId}`;
        const xhr = new XMLHttpRequest();
        xhr.open("GET", apiUrl, false);
        xhr.send(null);

        if (xhr.status === 200) {
            return JSON.parse(xhr.responseText);
        } else {
            console.error("❌ Failed to fetch video info from PeerTube API:", xhr.status);
            return null;
        }
    } catch (error) {
        console.error("❌ Error fetching video info:", error);
        return null;
    }
}

// --------------------------------------------------------------------
// Helper functions for regular videos (segments)
// Deduplicate segments within a session.
function deduplicateSegments(segments) {
    return segments.filter((seg, index, self) =>
        index === self.findIndex(s =>
            Math.abs(s.start - seg.start) < 0.001 && Math.abs(s.end - seg.end) < 0.001
        )
    );
}

// Function to calculate drift and adjust timing
function adjustInterval(targetInterval) {
    const averageExecutionTime = executionTimes.length > 0 ? executionTimes.reduce((a, b) => a + b, 0) / executionTimes.length : 0;
    let drift = averageExecutionTime - targetInterval * 1000; // drift in milliseconds
    // Limit the adjustment to a reasonable range to avoid over-correction
    let adjustment = Math.max(Math.min(drift, 100), -100);
    return targetInterval * 1000 - adjustment;
}

// Update the session segments for a regular video.
// For regular videos only, since live streams won't record segments.
function updateSession(video) {
    if (!video) return null;
    const time = video.currentTime;
    const playbackRate = video.playbackRate || 1;

    // If the video has jumped backward, adjust the session start.
    if (currentSession !== null && time < currentSession.start) {
        currentSession.start = time;
        console.log("⏪ Video jumped back. Updating session start to:", time);
    }

    // If the video is paused, finish the current segment.
    if (video.paused) {
        isVideoPlaying = false;
        if (currentSession !== null) {
            if (currentSession.start !== undefined && currentSession.lastRecordedTime !== undefined) {
                const segDuration = currentSession.lastRecordedTime - currentSession.start;
                if (segDuration > 0.1) {
                    if (!data.session) data.session = { segments: [] };
                    if (!data.session.segments) data.session.segments = [];
                    const segmentExists = data.session.segments.some(segment => {
                        const sameStart = Math.abs(segment.start - currentSession.start) < 0.1;
                        const sameEnd = Math.abs(segment.end - currentSession.lastRecordedTime) < 0.1;
                        return sameStart && sameEnd;
                    });
                    if (!segmentExists) {
                        data.session.segments.push({
                            start: currentSession.start,
                            end: currentSession.lastRecordedTime,
                            seg_duration: segDuration,
                            timestamp: new Date().toISOString()
                        });
                    }

                    data.sessionStart = currentSession.start;
                    currentSession = null;
                }
            }
            return null;
        }
    } else {
        // Video is playing.
        isVideoPlaying = true;
        // Increase tolerance (in seconds) to prevent creating multiple segments during continuous playback.
        let tolerance = (interval + 2) * playbackRate;
        if (currentSession === null) {
            currentSession = {
                start: time,
                lastRecordedTime: time
            };
            // Update the sessionStart field immediately when a new session starts
            data.sessionStart = time;
        } else {
            const gap = time - currentSession.lastRecordedTime;
            if (gap > tolerance && gap > 1) {
                const segDuration = currentSession.lastRecordedTime - currentSession.start;
                if (segDuration > 0.1) {
                    if (!data.session) data.session = { segments: [] };
                    if (!data.session.segments) data.session.segments = [];
                    const segmentExists = data.session.segments.some(segment => {
                        const sameStart = Math.abs(segment.start - currentSession.start) < 0.1;
                        const sameEnd = Math.abs(segment.end - currentSession.lastRecordedTime) < 0.1;
                        return sameStart && sameEnd;
                    });
                    if (!segmentExists) {
                        data.session.segments.push({
                            start: currentSession.start,
                            end: currentSession.lastRecordedTime,
                            seg_duration: segDuration,
                            timestamp: new Date().toISOString()
                        });
                    }

                    // Start a new session segment.
                    currentSession = {
                        start: time,
                        lastRecordedTime: time
                    };
                    // Update sessionStart with the new session's start time
                    data.sessionStart = time;
                }
            } else {
                // Just update sessionStart with the current session's start time
                data.sessionStart = currentSession.start;
            }
            currentSession.lastRecordedTime = time;
            return currentSession;
        }
    }
    return null;
}

// --------------------------------------------------------------------
// Save watch data and update chrome.storage.local.
// For live streams, simply accumulate watched time instead of segments.
function saveWatchData(isFinalSave = false) {
    const startTime = performance.now();
    const now = Date.now();
    const deltaSeconds = (now - lastSaveTime) / 1000;
    if (!isFinalSave && (now - lastSaveTime < interval * 1000)) return;
    lastSaveTime = now;

    const video = document.querySelector("video");
    if (!video && !isFinalSave) return;

    // Skip saving if not on a video URL to prevent errors on other pages
    if (!window.location.href.includes("/w/") && !window.location.href.includes("/videos/watch/")) {
        console.log("Skipping non-video URL:", window.location.href);
        return;
    }

    // For live streams, use the elapsed time if the video is playing
    if (data.isLive) {
        // Only add to watchedLiveSeconds if video is currently playing
        if (video && !video.paused) {
            // Add the elapsed time since last save to watchedLiveSeconds
            data.watchedLiveSeconds += deltaSeconds;
            console.log(`📺 Live stream watched for ${deltaSeconds.toFixed(2)} more seconds, total: ${data.watchedLiveSeconds.toFixed(2)}s`);
            
            // For live streams, set sessionStart to 0 when playing
            if (data.sessionStart === null) {
                data.sessionStart = 0;
            }
        }
        
        // Update title and URL (in case they changed)
        data.title = document.title;
        data.url = window.location.href;
        data.last_update = new Date().toISOString();
        
        // Check if entry already exists in prev array
        const existingIndex = prev.findIndex(item => item.url === data.url);
        if (existingIndex !== -1) {
            prev[existingIndex] = data;
        } else {
            prev.push(data);
        }
        
        // Save the entire prev array to storage
        chrome.storage.local.set({ peertubeWatchHistory: JSON.stringify(prev) }, () => {
            if (chrome.runtime.lastError) {
                console.error("Error saving live watch data:", chrome.runtime.lastError);
            } else {
                console.log(`📺 Live watch data saved (${data.watchedLiveSeconds.toFixed(2)}s watched)`);
            }
        });
        return;
    }

    // For regular videos:
    if (video && video.duration === 0) return;
    if (video && video.currentTime === previousCurrentTime && !isVideoPlaying) {
        //console.log("⏭️ Current time hasn't changed and video is paused. Skipping data saving.");
        return;
    }

    if (video) previousCurrentTime = video.currentTime;
    updateSession(video);
    if (data.session && Array.isArray(data.session.segments)) {
        data.session.segments = deduplicateSegments(data.session.segments);
    }

    const likeButton = document.querySelector("button.action-button-like");
    const dislikeButton = document.querySelector("button.action-button-dislike");
    const liked = likeButton ? likeButton.classList.contains("activated") : null;
    const disliked = dislikeButton ? dislikeButton.classList.contains("activated") : null;
    let totalSegDuration = 0;
    if (data.session?.segments) {
        data.session.segments.forEach(segment => {
            totalSegDuration += segment.seg_duration || 0;
        });
    }

    data.title = document.title;
    data.url = window.location.href;
    if (video) {
        data.currentTime = video.currentTime;
        data.duration = video.duration;

        if (video && video.duration > 0) {
            data.percentWatched = parseFloat(((totalSegDuration / video.duration) * 100).toFixed(2));
            data.finished = (video.currentTime / video.duration) > 0.95;
        } else {
            data.percentWatched = 0;
            data.finished = false;
        }
    }
    data.liked = liked;
    data.disliked = disliked;
    data.last_update = new Date().toISOString();

    // Use chrome.storage.local instead of localStorage
    chrome.storage.local.set({ peertubeWatchHistory: JSON.stringify(prev.map(item => item.url === data.url ? data : item)) }, () => {
        console.log("📺 Watch data saved to chrome.storage.local:", data);
    });

    const endTime = performance.now();
    const executionTime = endTime - startTime;
    executionTimes.push(executionTime);
    if (executionTimes.length > 10) {
        executionTimes.shift(); // Keep only the last 10 execution times
    }
}

// Function that will run after watch history is loaded
// Function to check if a video is live using the PeerTube API
async function checkIfVideoIsLive(videoUrl) {
    try {
        const videoIdMatch = videoUrl.match(/(?:\/videos\/watch\/|\/w\/|\/v\/)([a-zA-Z0-9\-_]+)/);
        if (!videoIdMatch) {
            console.warn("❌ Could not extract video ID from URL:", videoUrl);
            return false;
        }

        const videoId = videoIdMatch[1];
        const apiUrl = `${window.location.origin}/api/v1/videos/${videoId}`;
        
        const response = await fetch(apiUrl);
        if (!response.ok) {
            console.error(`❌ Failed to fetch video info: ${response.status} ${response.statusText}`);
            return false;
        }
        
        const videoInfo = await response.json();
        
        // Check if the video is a live stream based on the API response
        const isLive = videoInfo.isLive || videoInfo.state?.id === 12 || videoInfo.state?.label === 'Published (Live)';
        console.log(`🔍 API check for ${videoId}: isLive = ${isLive}`, videoInfo);
        
        return isLive;
    } catch (error) {
        console.error("❌ Error checking if video is live:", error);
        return false;
    }
}

// Modified main function that uses the API to check if a video is live
function main() {
    // Check if we're on a video page
    const isVideoPage = window.location.href.includes("/w/") || window.location.href.includes("/videos/watch/") || window.location.href.includes("/v/");
    if (isVideoPage) {
        // First use the API to check if it's a live stream
        checkIfVideoIsLive(window.location.href).then(isLiveFromAPI => {
            // Then update our data
            if (data) {
                const wasLive = data.isLive;
                data.isLive = isLiveFromAPI;
                
                // If this is a new live stream, reset the watched time counter
                if (data.isLive && !wasLive) {
                    data.watchedLiveSeconds = 0;
                    console.log("📺 New live stream detected via API. Reset watch counter.");
                }
                
                console.log("📹 Video API check complete, isLive:", data.isLive);
            } else {
                console.error("Data is null in main function!");
            }
            
            // Fallback to DOM detection only if API says it's not live
            if (!isLiveFromAPI) {
                const video = document.querySelector("video");
                if (video) {
                    // DOM-based live stream detection as fallback
                    const liveIndicator = document.querySelector(".live-info") ||
                        document.querySelector(".video-is-live") ||
                        document.querySelector("[data-livestream='true']") ||
                        (document.querySelector(".video-info-first-row") && 
                         document.querySelector(".video-info-first-row").textContent.includes("LIVE"));
                         
                    if (liveIndicator && data) {
                        console.log("📺 Live stream detected via DOM fallback");
                        const wasLive = data.isLive;
                        data.isLive = true;
                        
                        if (!wasLive) {
                            data.watchedLiveSeconds = 0;
                            console.log("📺 New live stream detected via DOM. Reset watch counter.");
                        }
                    }
                }
            }
            
            // Set up interval for tracking after we know if it's live or not
            setupTracking();
        }).catch(error => {
            console.error("Error in live check:", error);
            // Fall back to DOM detection if API fails
            fallbackToDOMDetection();
            setupTracking();
        });
    }
}

// Function to fall back to DOM-based detection
function fallbackToDOMDetection() {
    const video = document.querySelector("video");
    if (video && data) {
        // DOM-based live stream detection as fallback
        const liveIndicator = document.querySelector(".live-info") ||
            document.querySelector(".video-is-live") ||
            document.querySelector("[data-livestream='true']") ||
            (document.querySelector(".video-info-first-row") && 
             document.querySelector(".video-info-first-row").textContent.includes("LIVE"));
             
        if (liveIndicator) {
            console.log("📺 Live stream detected via DOM fallback");
            const wasLive = data.isLive;
            data.isLive = true;
            
            if (!wasLive) {
                data.watchedLiveSeconds = 0;
                console.log("📺 New live stream detected via DOM. Reset watch counter.");
            }
        }
    }
}

// Setup the tracking intervals based on whether it's a live stream or not
function setupTracking() {
    // Interval for saving watch data - use a shorter interval for live streams
    setInterval(() => {
        const video = document.querySelector("video");
        if (video) {
            // Check if it's a live stream from the data object
            const isCurrentlyLive = data && data.isLive;
            
            // For regular videos, update session
            if (!isCurrentlyLive) {
                updateSession(video);
            }
            
            // Save data for both regular and live videos
            saveWatchData();
        }
    }, data && data.isLive ? 5000 : adjustInterval(interval)); // Update every 5 seconds for live streams

    // Final save on unload
    window.addEventListener('beforeunload', function() {
        saveWatchData(true);
    });
    
    // Periodically re-check live status (every 2 minutes)
    setInterval(() => {
        if (data) {
            // Only re-check via API for videos that are currently marked as live
            // or that changed URL recently
            if (data.isLive || Date.now() - lastURLChangeTime < 300000) {
                checkIfVideoIsLive(window.location.href).then(isLiveFromAPI => {
                    if (data.isLive !== isLiveFromAPI) {
                        console.log(`📺 Live status changed from ${data.isLive} to ${isLiveFromAPI}`);
                        data.isLive = isLiveFromAPI;
                    }
                }).catch(error => {
                    console.error("Error in periodic live check:", error);
                });
            }
        }
    }, 120000); // Re-check every 2 minutes
}

// Add a global variable to track when URL last changed
let lastURLChangeTime = Date.now();

// Update URL change detection to set lastURLChangeTime
setInterval(() => {
    if (window.location.href !== lastURL) {
        console.log("URL changed from", lastURL, "to", window.location.href);
        lastURL = window.location.href;
        currentURL = window.location.href; // Update currentURL
        lastURLChangeTime = Date.now(); // Track when URL changed

        // Re-initialize data for the new URL
        data = initializeData();
        
        // Add the new data to the prev array if it doesn't exist
        const existingIndex = prev.findIndex(item => item.url === currentURL);
        if (existingIndex === -1) {
            prev.push(data);
        }
        
        loadWatchHistory(() => {
            console.log("Watch history loaded/reloaded after URL change.");
        });
    }
}, 1000);

// Call main function
main();


function triggerProcessedUUIDsLoad() {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', handleProcessedUUIDsFileSelect, false);
    document.body.appendChild(fileInput);
    fileInput.click();
}

function handleProcessedUUIDsFileSelect(evt) {
    const file = evt.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const loadedData = JSON.parse(e.target.result);
                if (Array.isArray(loadedData)) {
                    chrome.storage.local.set({ processedUUIDs: loadedData }, () => {
                        console.log("✅ Processed UUIDs loaded and saved to storage:", loadedData);
                    });
                } else {
                    console.error("❌ Invalid format in loaded file. Expected an array.");
                }
            } catch (err) {
                console.error("❌ Failed to parse the loaded file as JSON:", err);
            }
        };
        reader.readAsText(file);
    }
}


function triggerVideoUUIDsLoad() {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', handleVideoUUIDsFileSelect, false);
    document.body.appendChild(fileInput);
    fileInput.click();
}

function handleVideoUUIDsFileSelect(evt) {
    const file = evt.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const data = JSON.parse(e.target.result);
                chrome.runtime.sendMessage({
                    action: "loadVideoUUIDs",
                    data: data
                });
            } catch (e) {
                console.error("Error parsing JSON:", e);
            }
        };
        reader.readAsText(file);
    }
}

function triggerMetadataListLoad() {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', handleMetadataListFileSelect, false);
    document.body.appendChild(fileInput);
    fileInput.click();
}

function handleMetadataListFileSelect(evt) {
    const file = evt.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const data = JSON.parse(e.target.result);
                chrome.runtime.sendMessage({
                    action: "loadMetadataList",
                    data: data
                });
            } catch (e) {
                console.error("Error parsing JSON:", e);
            }
        };
        reader.readAsText(file);
    }
}

function runOnce(key, fn) {
    chrome.storage.local.get([key], (result) => {
        if (!result[key]) {
            fn();
            let obj = {};
            obj[key] = true;
            chrome.storage.local.set(obj);
        } else {
            console.log(`${key} has already run. Skipping.`);
        }
    });
}

// content.js
// Function to load and merge data from file
function loadAndMergeData(dataType) {
    const filename = `${dataType}.json`;
    fetch(chrome.runtime.getURL(filename))
        .then(response => response.json())
        .then(data => {
            chrome.runtime.sendMessage({
                action: `merge${dataType.charAt(0).toUpperCase() + dataType.slice(1)}`,
                data: data
            });
            console.log(`${filename} loaded successfully and merge requested.`);
        })
        .catch(error => console.error(`Could not load ${filename}:`, error));
}

// Load data for each type, using runOnce to ensure they only run once
runOnce('mergeProcessedUUIDsHasRun', () => loadAndMergeData("processedUUIDs"));
runOnce('mergeVideoUUIDsHasRun', () => loadAndMergeData("videoUUIDs"));
runOnce('mergeMetadataListHasRun', () => loadAndMergeData("metadataList"));
