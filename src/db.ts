// IndexedDB-backed message store. Replaces the ~5MB localStorage cap with the
// browser's much larger IDB quota (typically 50MB-1GB). Each message is stored
// individually so we can load only the recent ones into memory.

const DB_NAME = "chati-db";
const DB_VERSION = 1;
const STORE = "messages";

type StoredMsg = {
  id: string;
  roomId: string;
  ts: number;
  author: string;
  authorName?: string;
  text?: string;
  imageDataUrl?: string;
  replyTo?: { msgId: string; authorName: string; snippet: string };
};

let dbPromise: Promise<IDBDatabase> | null = null;
function getDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: "id" });
        s.createIndex("roomId", "roomId", { unique: false });
        s.createIndex("roomId_ts", ["roomId", "ts"], { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function saveMessageToDb(roomId: string, msg: Omit<StoredMsg, "roomId">): Promise<void> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ ...msg, roomId });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Load up to `limit` newest messages for a room, sorted ascending by ts. */
export async function loadMessagesFromDb(roomId: string, limit = 500): Promise<Omit<StoredMsg, "roomId">[]> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const idx = tx.objectStore(STORE).index("roomId");
    const req = idx.getAll(IDBKeyRange.only(roomId));
    req.onsuccess = () => {
      const all = (req.result as StoredMsg[]).sort((a, b) => a.ts - b.ts);
      const tail = all.slice(-limit);
      resolve(tail.map(({ roomId: _r, ...m }) => m));
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteRoomMessagesFromDb(roomId: string): Promise<void> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const idx = tx.objectStore(STORE).index("roomId");
    const req = idx.openKeyCursor(IDBKeyRange.only(roomId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        tx.objectStore(STORE).delete(cursor.primaryKey);
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
