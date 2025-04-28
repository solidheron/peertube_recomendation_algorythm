// db.js

const DB_NAME = 'peertubeDB';
const DB_VERSION = 2; // Incremented version to trigger schema upgrade
const METADATA_STORE = 'metadataList';

async function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error("❌ Error opening database:", request.error);
      reject(request.error);
    };

    request.onsuccess = (event) => {
      console.log("✅ Database opened successfully");
      resolve(event.target.result);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      
      // Create metadata store if it doesn't exist
      if (!db.objectStoreNames.contains(METADATA_STORE)) {
        const store = db.createObjectStore(METADATA_STORE, { keyPath: 'shortUUID' });
        
        // Add index for faster lookups by shortUUID
        store.createIndex(
          'shortUUIDIndex', 
          'shortUUID', 
          { unique: true } // Matches the keyPath uniqueness
        );
        
        console.log("📦 Created metadataList store with shortUUID index");
      }
    };
  });
}

// Save metadata list
async function saveMetadataList(metadataList) {
  try {
    const db = await initDB();
    const tx = db.transaction(METADATA_STORE, 'readwrite');
    const store = tx.objectStore(METADATA_STORE);

    // Clear existing data
    await new Promise((resolve, reject) => {
      const clearRequest = store.clear();
      clearRequest.onsuccess = resolve;
      clearRequest.onerror = () => reject(clearRequest.error);
    });

    // Add new data
    for (const metadata of metadataList) {
      await new Promise((resolve, reject) => {
        const request = store.put(metadata);
        request.onsuccess = resolve;
        request.onerror = () => reject(request.error);
      });
    }

    await new Promise((resolve) => {
      tx.oncomplete = resolve;
    });

    console.log("✅ Saved metadata list to IndexedDB");
  } catch (error) {
    console.error("❌ Error saving metadata list:", error);
    throw error;
  }
}

// Get metadata list
async function getMetadataList() {
  try {
    const db = await initDB();
    const tx = db.transaction(METADATA_STORE, 'readonly');
    const store = tx.objectStore(METADATA_STORE);

    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error("❌ Error getting metadata list:", error);
    throw error;
  }
}

// Update a single metadata item
async function updateMetadata(metadata) {
  try {
    const db = await initDB();
    const tx = db.transaction(METADATA_STORE, 'readwrite');
    const store = tx.objectStore(METADATA_STORE);

    return new Promise((resolve, reject) => {
      const request = store.put(metadata);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error("❌ Error updating metadata:", error);
    throw error;
  }
}

// Delete a single metadata item
async function deleteMetadata(shortUUID) {
  try {
    const db = await initDB();
    const tx = db.transaction(METADATA_STORE, 'readwrite');
    const store = tx.objectStore(METADATA_STORE);

    return new Promise((resolve, reject) => {
      const request = store.delete(shortUUID);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error("❌ Error deleting metadata:", error);
    throw error;
  }
}

// Make functions available globally
window.db = {
  initDB,
  saveMetadataList,
  getMetadataList,  // Ensure this is included
  updateMetadata,
  deleteMetadata
};