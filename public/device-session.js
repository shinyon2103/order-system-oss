const DEVICE_CREDENTIAL_KEYS = [
  "order-system:device-id",
  "order-system:device-key",
  "order-system:device-role",
  "order-system:device-reauth-grace-expires-at",
  "order-system:server-clock-offset-ms",
];

export function loadDeviceCredentials(sessionStore, legacyStore) {
  const sessionDeviceId = sessionStore.getItem(DEVICE_CREDENTIAL_KEYS[0]) || "";
  const sessionDeviceKey = sessionStore.getItem(DEVICE_CREDENTIAL_KEYS[1]) || "";
  if (sessionDeviceId && sessionDeviceKey) return readCredentials(sessionStore);

  const legacyDeviceId = legacyStore.getItem(DEVICE_CREDENTIAL_KEYS[0]) || "";
  const legacyDeviceKey = legacyStore.getItem(DEVICE_CREDENTIAL_KEYS[1]) || "";
  if (!legacyDeviceId || !legacyDeviceKey) return emptyCredentials();

  for (const key of DEVICE_CREDENTIAL_KEYS) {
    const value = legacyStore.getItem(key);
    if (value !== null) sessionStore.setItem(key, value);
    legacyStore.removeItem(key);
  }
  return readCredentials(sessionStore);
}

export function saveDeviceCredentials(sessionStore, credentials) {
  sessionStore.setItem(DEVICE_CREDENTIAL_KEYS[0], credentials.deviceId);
  sessionStore.setItem(DEVICE_CREDENTIAL_KEYS[1], credentials.deviceKey);
  sessionStore.setItem(DEVICE_CREDENTIAL_KEYS[2], credentials.deviceRole);
  sessionStore.setItem(DEVICE_CREDENTIAL_KEYS[3], credentials.deviceReauthGraceExpiresAt);
  sessionStore.setItem(DEVICE_CREDENTIAL_KEYS[4], String(credentials.serverClockOffsetMs));
}

export function clearDeviceCredentials(sessionStore) {
  for (const key of DEVICE_CREDENTIAL_KEYS) sessionStore.removeItem(key);
}

function readCredentials(store) {
  return {
    deviceId: store.getItem(DEVICE_CREDENTIAL_KEYS[0]) || "",
    deviceKey: store.getItem(DEVICE_CREDENTIAL_KEYS[1]) || "",
    deviceRole: store.getItem(DEVICE_CREDENTIAL_KEYS[2]) || "",
    deviceReauthGraceExpiresAt: store.getItem(DEVICE_CREDENTIAL_KEYS[3]) || "",
    serverClockOffsetMs: Number(store.getItem(DEVICE_CREDENTIAL_KEYS[4])) || 0,
  };
}

function emptyCredentials() {
  return { deviceId: "", deviceKey: "", deviceRole: "", deviceReauthGraceExpiresAt: "", serverClockOffsetMs: 0 };
}
