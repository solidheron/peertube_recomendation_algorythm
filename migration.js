// migration.js

import { saveMetadataList } from './db.js';

async function migrateToIndexedDB() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['metadataList'], async (result) => {
      if (result.metadataList) {
        try {
          await saveMetadataList(result.metadataList);
          // After successful migration, remove from chrome.storage
          chrome.storage.local.remove(['metadataList'], () => {
            console.log("✅ Successfully migrated metadata to IndexedDB");
            resolve(true);
          });
        } catch (error) {
          console.error("❌ Error during migration:", error);
          resolve(false);
        }
      } else {
        console.log("No metadata to migrate");
        resolve(true);
      }
    });
  });
}

// Run migration when extension updates
chrome.runtime.onInstalled.addListener(() => {
  migrateToIndexedDB();
});