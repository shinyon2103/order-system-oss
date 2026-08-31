export type OfflineNumberSettings = {
  offlinePrefix: string;
  offlineStartNumber: number;
};

type OfflineCounter = {
  id: "default";
  nextNumber: number;
};

const DATABASE_NAME = "order-system-offline";
const STORE_NAME = "counters";

export function formatOfflineNumber(settings: OfflineNumberSettings, number: number): string {
  if (!settings.offlinePrefix || !Number.isInteger(number) || number < settings.offlineStartNumber) {
    throw new Error("Invalid offline number");
  }
  return `${settings.offlinePrefix}${number}`;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

export async function nextOfflineNumber(settings: OfflineNumberSettings): Promise<string> {
  if (!settings.offlinePrefix || !Number.isInteger(settings.offlineStartNumber) || settings.offlineStartNumber < 0) {
    throw new Error("Invalid offline number settings");
  }

  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const read = store.get("default");
    let number = settings.offlineStartNumber;
    read.onsuccess = () => {
      const counter = read.result as OfflineCounter | undefined;
      number = Math.max(counter?.nextNumber ?? settings.offlineStartNumber, settings.offlineStartNumber);
      store.put({ id: "default", nextNumber: number + 1 } satisfies OfflineCounter);
    };
    transaction.oncomplete = () => {
      database.close();
      resolve(formatOfflineNumber(settings, number));
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Offline number allocation failed"));
    };
  });
}
