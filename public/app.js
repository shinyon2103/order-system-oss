import { createClientId } from "./client-id.js";
import { isOfflineDeviceAuthValid } from "./device-auth-grace.js";
import { kitchenAlertButtonState, shouldPlayKitchenAlert } from "./kitchen-alert.js";
import { PENDING_KITCHEN_COMPLETION_RENDER_ID, clearPendingKitchenCompletion, loadPendingKitchenCompletion, savePendingKitchenCompletion } from "./kitchen-offline-completion.js";
import { clearKitchenAssignment, loadKitchenAssignment, saveKitchenAssignment } from "./kitchen-offline-cache.js";
import { createKitchenCompletionKeyGuard, isKeyboardShortcutTarget } from "./kitchen-completion-key.js?v=1";
import { buildOrderLine } from "./menu-selection.js";
import { isNetworkUnavailable, prepareOfflineOrder, sortPendingOrders } from "./offline-sync.js";
import { installPageZoomGuard } from "./page-zoom.js?v=1";
import { calculateServerClockOffset, serverAdjustedIsoNow } from "./server-clock.js";
import { clearDeviceCredentials as clearStoredDeviceCredentials, loadDeviceCredentials, saveDeviceCredentials as saveStoredDeviceCredentials } from "./device-session.js";
import { parseRealtimeEventType, shouldRefreshProductCounts } from "./realtime-refresh.js";

const app = document.querySelector("#app");
const connectionStatus = document.querySelector("#connection-status");
const headerContext = document.querySelector("#header-context");
const FAST_KITCHEN_REFRESH_MS = 5_000;
const FALLBACK_REFRESH_MS = 30_000;
installPageZoomGuard();
const storedDeviceCredentials = loadDeviceCredentials(sessionStorage, localStorage);
const state = {
  eventId: localStorage.getItem("order-system:event-id") || "",
  currentEvent: null,
  ...storedDeviceCredentials,
  selectedItem: null,
  selectedOptions: [],
  quantity: 1,
  menuItems: [],
  cart: [],
  receptionMode: "DIRECT",
  modalDraft: null,
  kitchenOrder: null,
  kitchenAway: false,
  kitchenLastSeenOrderId: null,
  kitchenRequestGeneration: 0,
  kitchenCompletionInFlight: false,
  kitchenCompletionBlockedUntil: 0,
  kitchenPendingCompletion: null,
  kitchenSoundPreferred: localStorage.getItem("order-system:kitchen-sound") === "on",
  kitchenSoundReady: false,
  kitchenAudioContext: null,
  refreshTimer: null,
  eventRefreshTimer: null,
  socket: null,
  socketReconnectTimer: null,
  socketReconnectAttempt: 0,
  socketGeneration: 0,
  resumeInFlight: false,
  receptionSubmitting: false,
  undoAction: null,
  undoTimer: null,
  adminToken: sessionStorage.getItem("order-system:admin-token") || "",
  adminItemTotal: null,
  adminProductCounts: null,
  publicTicketNumber: "",
};

function setConnection(status = navigator.onLine ? "online" : "offline") {
  const labels = {
    online: "オンライン",
    reconnecting: "再接続中",
    offline: "オフライン",
  };
  connectionStatus.textContent = labels[status] || labels.offline;
  connectionStatus.className = `connection-status ${status}`;
}

window.addEventListener("online", () => {
  setConnection("online");
  if (["reception", "kitchen", "delivery"].includes(currentRoute()) || document.body.dataset.screen === "device-auth") void route();
  else { setConnection("online"); subscribeRealtime(); }
});
window.addEventListener("offline", () => setConnection("offline"));
window.addEventListener("pageshow", (event) => { if (event.persisted) void recoverFromSuspension(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void recoverFromSuspension(); });
setConnection();

if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    // 登録URLにも世代を付け、古いPWA登録が更新確認を妨げないようにする。
    void navigator.serviceWorker.register("/service-worker.js?v=29").catch((error) => {
      console.warn("Service Workerを登録できませんでした", error);
    });
  });
}

async function api(path, options = {}) {
  let response;
  try {
    const hasBody = options.body !== undefined && options.body !== null;
    response = await fetch(path, {
      cache: "no-store",
      ...options,
      headers: {
        ...(hasBody ? { "content-type": "application/json" } : {}),
        ...(state.deviceId && state.deviceKey ? { "X-Device-ID": state.deviceId, "X-Device-Key": state.deviceKey } : {}),
        ...(options.headers || {}),
      },
    });
  } catch (cause) {
    setConnection(navigator.onLine ? "reconnecting" : "offline");
    const error = new Error("サーバーへ接続できません。通信状態を確認してください。");
    error.code = "NETWORK_UNAVAILABLE";
    error.cause = cause;
    throw error;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(describeError(data.error, response.status));
    error.code = data.error || "HTTP_ERROR";
    error.status = response.status;
    throw error;
  }
  if (navigator.onLine) setConnection("online");
  return data;
}

function describeError(code, status) {
  const messages = {
    INVALID_REQUEST: "入力内容を確認してください。",
    INVALID_MENU_SELECTION: "メニューまたは味付けが更新されています。画面を再読み込みして選び直してください。",
    INVALID_JSON: "送信内容を読み取れませんでした。",
    INVALID_LOGIN_NAME: "ログイン名は3文字以上で入力してください。",
    INVALID_PASSWORD_LENGTH: "パスワードは12〜256文字で入力してください。",
    PASSWORD_TOO_SHORT: "パスワードは12文字以上で入力してください。",
    INVALID_CREDENTIALS: "ログイン名またはパスワードが違います。",
    RATE_LIMITED: "ログイン試行が多すぎます。15分ほど待ってから再試行してください。",
    SETUP_ALREADY_COMPLETED: "初回設定は完了済みです。作成済みの管理者情報でログインしてください。",
    ADMIN_SETUP_NOT_CONFIGURED: "初回設定用のSecretが未設定です。管理者に確認してください。",
    ADMIN_RECOVERY_NOT_CONFIGURED: "管理者復旧用のCloudflare Secretが未設定です。Cloudflare Dashboardで ADMIN_RECOVERY_TOKEN を設定してください。",
    INVALID_SETUP_TOKEN: "初回セットアップトークンが違います。",
    INVALID_RECOVERY_TOKEN: "復旧トークンが違います。",
    ADMIN_NOT_FOUND: "復旧できる管理者が見つかりません。初回セットアップを使用してください。",
    ADMIN_RECOVERY_AMBIGUOUS: "有効な管理者が複数いるため、安全のため自動復旧できません。",
    UNAUTHENTICATED: "管理者ログインが必要です。",
    DEVICE_AUTH_REQUIRED: "この端末の認証が必要です。",
    INVALID_DEVICE_CREDENTIALS: "端末IDまたは端末キーが違うか、この端末が無効です。",
    DEVICE_ROLE_FORBIDDEN: "この端末には、この画面を操作する権限がありません。",
    SESSION_EXPIRED: "管理者セッションの有効期限が切れています。もう一度ログインしてください。",
    EVENT_ID_REQUIRED: "営業日が選択されていません。",
    EVENT_NOT_OPEN: "営業日が開始されていません。管理画面で営業日を開始してください。",
    EVENT_NOT_FOUND: "指定した営業日が見つかりません。",
    ONLINE_NUMBER_EXHAUSTED: "オンライン受付番号を使い切りました。管理画面で番号範囲を変更してください。",
    INVALID_TICKET_NUMBER: "受付番号を発行できませんでした。",
    DEVICE_ALREADY_EXISTS: "その端末IDはすでに登録されています。",
    DEVICE_NOT_FOUND: "指定した端末が見つかりません。",
    MENU_ITEM_NOT_FOUND: "指定したメニューが見つかりません。",
    OPTION_GROUP_NOT_FOUND: "指定した味付けグループが見つかりません。",
    MENU_OPTION_NOT_FOUND: "指定した味付けが見つかりません。",
    INVALID_MODE: "受付方式の指定が正しくありません。",
    INVALID_STATE_TRANSITION: "現在の注文状態では、その操作はできません。",
    DEVICE_MISMATCH: "この注文は別の調理端末に割り当てられています。",
    MENU_ITEM_HAS_ORDERS: "このメニューは注文履歴に使われているため完全には削除できません。",
    DEVICE_HAS_ACTIVE_ASSIGNMENT: "この端末は調理中の注文を持っているため削除できません。先に調理待ちへ戻してください。",
    KITCHEN_AWAY_MODE_REQUIRED: "担当中の注文をどうするか選択してください。",
    KITCHEN_UNSTARTED_CONFIRMATION_REQUIRED: "調理開始前であることを確認してください。",
    EVENT_IS_OPEN: "開始中の営業日は削除できません。先に営業を終了してください。",
    EVENT_HAS_ORDERS: "この営業日には注文履歴があるため削除できません。",
    ORDER_NOT_FOUND: "指定した注文が見つかりません。",
    PREVIOUS_KITCHEN_NOT_FOUND: "前の調理担当端末が記録されていないため戻せません。",
    PREVIOUS_KITCHEN_UNAVAILABLE: "前の調理担当端末が無効なため戻せません。管理画面で端末を確認してください。",
    COOKING_CANCEL_CONFIRMATION_REQUIRED: "調理中注文の強制取消には、受付番号を含む二段階確認が必要です。",
    UNDO_NOT_AVAILABLE: "この操作は元に戻せません。",
    UNDO_ACTOR_MISMATCH: "この操作を行った端末からのみ元に戻せます。",
    UNDO_ALREADY_USED: "この操作はすでに元に戻されています。",
    UNDO_EXPIRED: "10秒を過ぎたため、元に戻せません。",
    UNDO_STATE_CHANGED: "後続の操作が行われたため、安全に元へ戻せません。",
  };
  return messages[code] || (code ? `処理に失敗しました（${code}）。` : `通信に失敗しました（HTTP ${status}）。`);
}

function layout(title, lead, content, options = {}) {
  clearTimer();
  clearUndoAction();
  const screen = options.screen || "default";
  document.body.dataset.screen = screen;
  headerContext.textContent = options.context || title;
  app.className = `app-shell screen-${screen}`;
  app.innerHTML = `<header class="screen-heading"><div>${options.eyebrow ? `<div class="screen-eyebrow">${options.eyebrow}</div>` : ""}<h1 class="screen-title">${title}</h1><p class="screen-lead">${lead}</p></div>${options.headingAction || ""}</header>${content}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>\"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[character]);
}

function clearUndoAction() {
  if (state.undoTimer) window.clearInterval(state.undoTimer);
  state.undoTimer = null;
  state.undoAction = null;
  document.querySelector("#undo-banner")?.remove();
}

function renderUndoAction() {
  const action = state.undoAction;
  if (!action) return;
  const remainingMs = action.expiresAt - Date.now();
  if (remainingMs <= 0) { clearUndoAction(); return; }
  let banner = document.querySelector("#undo-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "undo-banner";
    banner.className = "undo-banner";
    banner.setAttribute("role", "status");
    document.body.append(banner);
  }
  banner.innerHTML = `<div><strong>${escapeHtml(action.label)}</strong><small>あと <span data-undo-seconds>${Math.ceil(remainingMs / 1000)}</span> 秒</small></div><button type="button" class="undo-button">元に戻す</button>`;
  banner.querySelector(".undo-button").onclick = () => { void performUndoAction(); };
}

function offerUndo({ operationId, expiresAt, label, adminToken = "", onUndone, run }) {
  clearUndoAction();
  const parsedExpiry = Date.parse(expiresAt || "");
  const serverNow = Date.now() + (Number(state.serverClockOffsetMs) || 0);
  const remainingMs = Number.isFinite(parsedExpiry) ? Math.max(0, parsedExpiry - serverNow) : 10_000;
  state.undoAction = {
    operationId,
    expiresAt: Date.now() + Math.min(remainingMs, 10_000),
    label,
    adminToken,
    onUndone,
    run,
  };
  renderUndoAction();
  state.undoTimer = window.setInterval(renderUndoAction, 250);
}

async function performUndoAction() {
  const action = state.undoAction;
  if (!action || action.inFlight || Date.now() > action.expiresAt) { clearUndoAction(); return false; }
  action.inFlight = true;
  const button = document.querySelector("#undo-banner .undo-button");
  if (button) { button.disabled = true; button.textContent = "戻しています…"; }
  try {
    if (action.run) await action.run();
    else {
      const prefix = action.adminToken ? "/api/admin/operations" : "/api/operations";
      await api(`${prefix}/${encodeURIComponent(action.operationId)}/undo`, {
        method: "POST",
        headers: action.adminToken ? { Authorization: `Bearer ${action.adminToken}` } : {},
        body: JSON.stringify({ eventId: state.eventId, undoOperationId: createClientId() }),
      });
    }
    const onUndone = action.onUndone;
    clearUndoAction();
    await onUndone?.();
    return true;
  } catch (error) {
    clearUndoAction();
    window.alert(error.message);
    return false;
  }
}

function renderOrderItems(items = []) {
  return `<ul class="order-item-details">${items.map((item) => {
    const options = (item.options || []).map((option) => `<span class="${option.required ? "required-order-option" : ""}">${option.required ? `<b>必須</b>` : ""}${escapeHtml(option.group_name)}：${escapeHtml(option.option_name)}</span>`).join("");
    const note = item.note ? `<span>備考：${escapeHtml(item.note)}</span>` : "";
    return `<li><div><strong>${escapeHtml(item.item_name)}</strong><small>${options}${note}</small></div><b>×${escapeHtml(item.quantity)}</b></li>`;
  }).join("")}</ul>`;
}

function formatOrderTime(value) {
  return value ? new Date(value).toLocaleString("ja-JP") : "—";
}

const deviceRoleLabels = { RECEPTION: "受付", KITCHEN: "調理", DELIVERY: "受け渡し", DISPLAY: "表示", ADMIN: "管理" };

async function validateDeviceCredentials(deviceId, deviceKey) {
  const response = await fetch("/api/device/session", { headers: { "X-Device-ID": deviceId, "X-Device-Key": deviceKey } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(describeError(data.error, response.status));
  return data;
}

function saveDeviceCredentials(session, deviceKey) {
  const { device } = session;
  state.deviceId = device.id;
  state.deviceKey = deviceKey;
  state.deviceRole = device.role;
  state.deviceReauthGraceExpiresAt = session.reauthGraceExpiresAt;
  state.serverClockOffsetMs = calculateServerClockOffset(session.authenticatedAt);
  saveStoredDeviceCredentials(sessionStorage, {
    deviceId: state.deviceId,
    deviceKey: state.deviceKey,
    deviceRole: state.deviceRole,
    deviceReauthGraceExpiresAt: state.deviceReauthGraceExpiresAt,
    serverClockOffsetMs: state.serverClockOffsetMs,
  });
}

function clearDeviceCredentials() {
  state.deviceId = "";
  state.deviceKey = "";
  state.deviceRole = "";
  state.deviceReauthGraceExpiresAt = "";
  state.serverClockOffsetMs = 0;
  clearStoredDeviceCredentials(sessionStorage);
}

async function ensureDeviceRole(expectedRole, resume) {
  if (!navigator.onLine) {
    if (state.deviceId && state.deviceKey && isOfflineDeviceAuthValid({ role: state.deviceRole, expectedRole, reauthGraceExpiresAt: state.deviceReauthGraceExpiresAt })) return true;
    const label = deviceRoleLabels[expectedRole] || expectedRole;
    layout("再認証が必要です", `${label}端末の再認証猶予が切れているため、ネットワーク復旧後に端末認証を行ってください。`, `<div class="panel locked-state"><span aria-hidden="true">鍵</span><strong>現在はオフラインです</strong><small>オンラインに戻ると自動で認証を再確認します。</small></div>`, { screen: "device-auth", context: `${label}端末`, eyebrow: "DEVICE AUTH" });
    return false;
  }
  if (state.deviceId && state.deviceKey) {
    try {
      const session = await validateDeviceCredentials(state.deviceId, state.deviceKey);
      if (session.device.role === expectedRole) {
        saveDeviceCredentials(session, state.deviceKey);
        return true;
      }
    } catch { /* 認証フォームで再入力する */ }
  }
  const label = deviceRoleLabels[expectedRole] || expectedRole;
  layout("端末認証", `${label}端末としてこのウィンドウを使うため、管理者から受け取った情報を入力してください。別のウィンドウは別の役割で同時に利用できます。`, `<form id="device-auth-form" class="panel form-grid device-auth-card"><label>端末ID<input name="deviceId" value="${escapeHtml(state.deviceId)}" required autocomplete="username" /></label><label>端末キー<input name="deviceKey" type="password" required autocomplete="current-password" /></label><button class="primary">このウィンドウを認証</button><div id="device-auth-message"></div></form>`, { screen: "device-auth", context: `${label}端末`, eyebrow: "DEVICE AUTH" });
  document.querySelector("#device-auth-form").onsubmit = async (event) => {
    event.preventDefault();
    const message = document.querySelector("#device-auth-message");
    const data = Object.fromEntries(new FormData(event.target));
    try {
      const session = await validateDeviceCredentials(String(data.deviceId).trim(), String(data.deviceKey).trim());
      if (session.device.role !== expectedRole) throw new Error(`${deviceRoleLabels[session.device.role] || session.device.role}端末のキーです。この画面では使用できません。`);
      saveDeviceCredentials(session, String(data.deviceKey).trim());
      await resume();
    } catch (error) {
      message.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    }
  };
  return false;
}

function deviceBadge() {
  return `<div class="device-identity"><span>認証済み</span><strong>${escapeHtml(state.deviceId)}</strong><button type="button" class="text-action" id="change-device-auth">変更</button></div>`;
}

function bindDeviceChange() {
  const button = document.querySelector("#change-device-auth");
  if (button) button.onclick = () => { clearDeviceCredentials(); route(); };
}

function resetRealtimeSocket() {
  if (state.socketReconnectTimer) window.clearTimeout(state.socketReconnectTimer);
  state.socketReconnectTimer = null;
  state.socketReconnectAttempt = 0;
  state.socketGeneration += 1;
  if (state.socket) {
    state.socket.onclose = null;
    state.socket.close();
    state.socket = null;
  }
}

function clearTimer() {
  if (state.refreshTimer) window.clearInterval(state.refreshTimer);
  state.refreshTimer = null;
  if (state.eventRefreshTimer) window.clearInterval(state.eventRefreshTimer);
  state.eventRefreshTimer = null;
  resetRealtimeSocket();
}

function eventPanel() {
  return `<div class="event-status"><span class="status-dot" aria-hidden="true"></span><span><small>営業日</small><strong id="current-event-label">確認中</strong></span></div>`;
}

async function loadCurrentEvent() {
  try {
    const result = await api("/api/current-business-day", { cache: "no-store" });
    state.currentEvent = result.event;
    if (result.event) {
      state.eventId = result.event.id;
      localStorage.setItem("order-system:event-id", state.eventId);
    } else {
      state.eventId = "";
      localStorage.removeItem("order-system:event-id");
    }
  } catch { return false; }
  const label = document.querySelector("#current-event-label");
  if (label) {
    label.textContent = state.currentEvent ? `${state.currentEvent.name}（${state.currentEvent.business_date}）` : "営業日が開始されていません";
    label.closest(".event-status")?.classList.toggle("inactive", !state.currentEvent);
  }
  return true;
}

async function syncCurrentEvent() {
  const previousEventId = state.eventId;
  const loaded = await loadCurrentEvent();
  if (!loaded) return;
  if (previousEventId !== state.eventId) {
    resetRealtimeSocket();
    await refreshRealtimeScreen();
  }
  if (state.eventId) subscribeRealtime();
  else setConnection("online");
}

function startCurrentEventSync() {
  if (state.eventRefreshTimer) window.clearInterval(state.eventRefreshTimer);
  state.eventRefreshTimer = window.setInterval(() => {
    if (document.visibilityState !== "hidden") void syncCurrentEvent();
  }, FALLBACK_REFRESH_MS);
}

async function refreshRealtimeScreen(eventType = null) {
  const path = currentRoute();
  if (path === "reception") {
    const refreshes = [syncPendingOrders()];
    if (shouldRefreshProductCounts(eventType)) refreshes.push(loadReceptionProductCounts());
    await Promise.all(refreshes);
  }
  if (path === "delivery") await loadReadyOrders();
  if (path === "display") await loadDisplay();
  if (path === "kitchen") await loadNextKitchen();
  if (path === "admin" && state.adminToken) {
    await loadAdminStatus(state.adminToken, { refreshProducts: shouldRefreshProductCounts(eventType) });
  }
}

function subscribeRealtime() {
  if (!state.eventId || !window.WebSocket || !navigator.onLine) return;
  if (state.socket?.readyState === WebSocket.OPEN || state.socket?.readyState === WebSocket.CONNECTING) return;
  if (state.socketReconnectTimer) window.clearTimeout(state.socketReconnectTimer);
  state.socketReconnectTimer = null;

  const generation = state.socketGeneration;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/api/realtime?eventId=${encodeURIComponent(state.eventId)}`);
  state.socket = socket;

  socket.onopen = () => {
    if (generation !== state.socketGeneration) return;
    state.socketReconnectAttempt = 0;
    setConnection("online");
    void refreshRealtimeScreen();
  };
  socket.onmessage = (event) => { void refreshRealtimeScreen(parseRealtimeEventType(event.data)); };
  socket.onerror = () => socket.close();
  socket.onclose = () => {
    if (generation !== state.socketGeneration) return;
    if (state.socket === socket) state.socket = null;
    if (!navigator.onLine) {
      setConnection("offline");
      return;
    }
    // WebSocketの一時切断は、通常のHTTP通信が切れたことを意味しない。
    // 定期取得と再接続は続けるが、接続表示はHTTPの到達可否で判定する。
    setConnection("online");
    void syncCurrentEvent();
    const delay = Math.min(1000 * (2 ** state.socketReconnectAttempt), 15000);
    state.socketReconnectAttempt += 1;
    state.socketReconnectTimer = window.setTimeout(() => {
      state.socketReconnectTimer = null;
      subscribeRealtime();
    }, delay);
  };
}

async function recoverFromSuspension() {
  if (document.visibilityState === "hidden" || state.resumeInFlight) return;
  if (!navigator.onLine) {
    setConnection("offline");
    return;
  }
  state.resumeInFlight = true;
  setConnection("online");
  resetRealtimeSocket();

  try {
    const path = currentRoute();
    const expectedRole = { reception: "RECEPTION", kitchen: "KITCHEN", delivery: "DELIVERY", display: "DISPLAY" }[path];
    if (expectedRole) {
      try {
        const session = await validateDeviceCredentials(state.deviceId, state.deviceKey);
        if (session.device.role !== expectedRole) throw new Error("DEVICE_ROLE_FORBIDDEN");
        saveDeviceCredentials(session, state.deviceKey);
      } catch {
        clearDeviceCredentials();
        setConnection("online");
        route();
        return;
      }
    }

    if (["reception", "kitchen", "delivery", "display"].includes(path)) await loadCurrentEvent();
    if (path === "reception") {
      await syncPendingOrders();
      await loadMenuButtons();
      await loadReceptionProductCounts();
    } else if (path === "kitchen") {
      await loadNextKitchen();
    } else if (path === "delivery") {
      await loadReadyOrders();
    } else if (path === "display") {
      await loadDisplay();
    } else if (path === "admin" && state.adminToken) {
      await loadAdminData();
    }

    if (["reception", "kitchen", "delivery", "display"].includes(path)) subscribeRealtime();
    if (!state.eventId || path === "admin" || !path) setConnection("online");
  } finally {
    state.resumeInFlight = false;
  }
}

function home() {
  const roles = {
    reception: ["受付", "注文を受け付ける"],
    kitchen: ["調理", "次の注文を調理する"],
    delivery: ["受け渡し", "完成した注文を渡す"],
    display: ["お客様向け表示", "調理状況と呼び出し番号"],
    admin: ["管理", "営業日・メニュー・端末設定"],
    status: ["注文状況確認", "自分の受付番号を確認"],
  };
  const lastRoute = localStorage.getItem("order-system:last-route");
  const lastRole = roles[lastRoute];
  const resume = lastRole ? `<a class="resume-card" href="/${lastRoute}" data-route="${lastRoute}"><span><small>前回使用した画面</small><strong>${lastRole[0]}</strong></span><span class="route-arrow" aria-hidden="true">→</span></a>` : "";
  layout("この端末の用途を選ぶ", "役割を選ぶと、各端末専用の画面が開きます。", `${resume}
    <section class="role-section" aria-labelledby="staff-role-title">
      <div class="section-label"><span id="staff-role-title">スタッフが使う画面</span><small>日々の操作</small></div>
      <div class="role-grid primary-roles">
        <a class="role-card reception" href="/reception" data-route="reception"><span class="role-icon" aria-hidden="true">受</span><span><strong>受付</strong><small>注文内容を入力して受付番号を発行</small></span><span class="route-arrow" aria-hidden="true">→</span></a>
        <a class="role-card kitchen" href="/kitchen" data-route="kitchen"><span class="role-icon" aria-hidden="true">調</span><span><strong>調理</strong><small>割り当てられた注文を確認して完了</small></span><span class="route-arrow" aria-hidden="true">→</span></a>
        <a class="role-card delivery" href="/delivery" data-route="delivery"><span class="role-icon" aria-hidden="true">渡</span><span><strong>受け渡し</strong><small>完成した注文を確認して提供済みに</small></span><span class="route-arrow" aria-hidden="true">→</span></a>
      </div>
    </section>
    <section class="role-section secondary-roles" aria-labelledby="other-role-title">
      <div class="section-label"><span id="other-role-title">表示・設定</span><small>必要な端末だけで使用</small></div>
      <div class="role-grid">
        <a class="role-card display" href="/display" data-route="display"><span class="role-icon" aria-hidden="true">表</span><span><strong>お客様向け表示</strong><small>調理中・受け渡し可能な番号を表示</small></span><span class="route-arrow" aria-hidden="true">→</span></a>
        <a class="role-card admin" href="/admin" data-route="admin"><span class="role-icon" aria-hidden="true">管</span><span><strong>管理</strong><small>営業日、メニュー、端末を設定</small></span><span class="route-arrow" aria-hidden="true">→</span></a>
      </div>
    </section>
    <section class="role-section public-status-entry" aria-labelledby="customer-role-title"><div class="section-label"><span id="customer-role-title">お客様が使う画面</span><small>端末キー不要</small></div><a class="role-card status" href="/status" data-route="status"><span class="role-icon" aria-hidden="true">番</span><span><strong>自分の注文状況を確認</strong><small>受付番号を入力して待ち状況を表示</small></span><span class="route-arrow" aria-hidden="true">→</span></a></section>`, { screen: "home", context: "端末メニュー", eyebrow: "ORDER SYSTEM" });
}

async function reception() {
  if (!await ensureDeviceRole("RECEPTION", reception)) return;
  layout("受付", "商品を選び、注文内容を確認して受付を確定します。", `<div class="reception-workspace">
    <section class="workspace-main panel"><div id="menu-toolbar"></div><div id="menu-buttons" class="menu-grid"><div class="empty"><span class="loading-dot"></span>メニューを読み込み中</div></div></section>
    <aside class="order-sidebar panel"><div class="sidebar-heading"><div><small>現在の注文</small><h2>注文内容</h2></div><span id="cart-count" class="count-badge">0点</span></div><div id="pending-sync-status" class="pending-sync-status" role="status" hidden></div><div id="cart-items" class="stack" aria-label="注文商品一覧"></div><div id="reception-message" aria-live="assertive"></div><button class="primary submit-order" id="submit-order" disabled><span>受付を確定する</span><small>受付番号を発行</small></button></aside>
  </div><section class="panel reception-product-summary"><div class="section-heading"><div><span class="step-label">PRODUCT COUNTS</span><h2>商品別の注文数</h2><p>味付けなどのオプションは分けず、取消済みを除いた商品数量を表示します。</p></div><button type="button" class="secondary-action" id="refresh-reception-product-counts">更新</button></div><div id="reception-product-counts"><div class="empty compact-empty">集計を読み込み中</div></div></section><section class="panel reception-cancel-panel"><div><span class="step-label">ORDER CANCELLATION</span><h2>注文を取り消す</h2><p>受付番号を入力し、注文内容を確認してから取り消します。調理中の注文は取り消せません。</p></div><form id="reception-order-lookup" class="ticket-lookup-form"><label>受付番号<input name="ticketNumber" inputmode="text" maxlength="64" required autocomplete="off" placeholder="例：100" /></label><button type="submit" class="secondary-action">注文詳細を表示</button></form><div id="reception-order-lookup-message" aria-live="polite"></div></section><dialog id="reception-cancel-modal"></dialog><dialog id="reception-receipt-modal"></dialog><dialog id="item-modal"></dialog>${deviceBadge()}`, { screen: "reception", context: "受付端末", eyebrow: "RECEPTION", headingAction: `<div class="screen-status">${eventPanel()}</div>` });
  bindDeviceChange();
  await loadCurrentEvent();
  startCurrentEventSync();
  void syncPendingOrders();
  subscribeRealtime();
  document.querySelector("#submit-order").onclick = submitReception;
  document.querySelector("#reception-order-lookup").onsubmit = lookupReceptionOrder;
  document.querySelector("#refresh-reception-product-counts").onclick = async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    await loadReceptionProductCounts();
    if (button.isConnected) button.disabled = false;
  };
  await loadMenuButtons();
  await loadReceptionProductCounts();
}

function renderProductCountTable(productCounts, { showManagementColumns = false } = {}) {
  if (!productCounts?.length) return `<div class="empty compact-empty">注文商品はまだありません</div>`;
  const managementHeadings = showManagementColumns ? `<th scope="col">注文</th><th scope="col">取消</th>` : "";
  const managementCells = (product) => showManagementColumns
    ? `<td data-label="注文">${escapeHtml(product.order_count)}件</td><td data-label="取消">${escapeHtml(product.cancelled_quantity)}点</td>`
    : "";
  return `<div class="product-count-table-wrap"><table class="product-count-table"><thead><tr><th scope="col">商品</th>${managementHeadings}<th scope="col">数量</th></tr></thead><tbody>${productCounts.map((product) => `<tr><th scope="row"><span>${escapeHtml(product.item_name)}</span>${showManagementColumns ? `<small>${escapeHtml(product.item_code)}</small>` : ""}</th>${managementCells(product)}<td data-label="数量"><strong>${escapeHtml(product.quantity)}</strong>点</td></tr>`).join("")}</tbody></table></div>`;
}

async function loadReceptionProductCounts() {
  const target = document.querySelector("#reception-product-counts");
  if (!target) return;
  if (!state.eventId) {
    target.innerHTML = `<div class="empty compact-empty">営業日が開始されると集計を表示します</div>`;
    return;
  }
  try {
    const result = await api(`/api/reception/product-summary?eventId=${encodeURIComponent(state.eventId)}`);
    target.innerHTML = renderProductCountTable(result.productCounts);
  } catch (error) {
    target.innerHTML = `<div class="stale-data-warning"><strong>商品別集計を取得できません</strong><span>${escapeHtml(error.message)}</span></div>`;
  }
}

async function lookupReceptionOrder(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.querySelector("#reception-order-lookup-message");
  if (!state.eventId) { message.innerHTML = `<div class="error">営業日が開始されていません。</div>`; return; }
  const ticketNumber = String(new FormData(form).get("ticketNumber") || "").trim();
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const result = await api(`/api/reception/orders/lookup?eventId=${encodeURIComponent(state.eventId)}&ticketNumber=${encodeURIComponent(ticketNumber)}`);
    message.replaceChildren();
    openReceptionCancelDialog(result.order);
  } catch (error) {
    message.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
  } finally {
    submit.disabled = false;
  }
}

function openReceptionCancelDialog(order) {
  const modal = document.querySelector("#reception-cancel-modal");
  const statusLabels = { WAITING: "調理待ち", COOKING: "調理中", READY: "受け渡し待ち", COMPLETED: "提供済み", CANCELLED: "取消済み" };
  const cancellable = ["WAITING", "READY", "COMPLETED"].includes(order.status);
  const blockedMessage = order.status === "COOKING" ? "この注文は調理中のため取り消せません。管理者画面から調理待ちへ戻してから操作してください。" : "この注文はすでに取り消されています。";
  modal.innerHTML = `<form id="reception-cancel-form" class="modal-card"><div class="modal-header"><div><span class="step-label">ORDER DETAILS</span><h2>受付番号 ${escapeHtml(order.ticket_number)}</h2></div><button type="button" class="modal-close" aria-label="閉じる">×</button></div><div class="audit-current-status">現在：<span class="status-tag ${escapeHtml(order.status.toLowerCase())}">${escapeHtml(statusLabels[order.status] || order.status)}</span></div>${renderOrderItems(order.items)}${cancellable ? `<div class="warning-message">内容と番号を確認してください。操作後10秒以内なら元に戻せます。</div><label>取消理由<textarea name="reason" rows="3" maxlength="200" required placeholder="例：お客様からの申出"></textarea></label>` : `<div class="warning-message">${escapeHtml(blockedMessage)}</div>`}<div id="reception-cancel-message" aria-live="assertive"></div><div class="button-row"><button type="button" class="secondary-action modal-close-action">閉じる</button>${cancellable ? `<button type="submit" class="danger">この注文を取り消す</button>` : ""}</div></form>`;
  modal.querySelectorAll(".modal-close, .modal-close-action").forEach((button) => { button.onclick = () => modal.close(); });
  if (cancellable) modal.querySelector("#reception-cancel-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('button[type="submit"]');
    const message = form.querySelector("#reception-cancel-message");
    const reason = String(new FormData(form).get("reason") || "").trim();
    submit.disabled = true;
    try {
      const operationId = createClientId();
      const result = await api(`/api/reception/orders/${encodeURIComponent(order.id)}/cancel`, { method: "POST", body: JSON.stringify({ operationId, reason }) });
      modal.close();
      document.querySelector("#reception-order-lookup").reset();
      document.querySelector("#reception-order-lookup-message").innerHTML = `<div class="success-message">受付番号 ${escapeHtml(order.ticket_number)} を取り消しました。</div>`;
      offerUndo({ operationId: result.undoOperationId || operationId, expiresAt: result.undoExpiresAt, label: `受付番号 ${order.ticket_number} の取消を元に戻す`, onUndone: async () => {
        document.querySelector("#reception-order-lookup-message").innerHTML = `<div class="success-message">受付番号 ${escapeHtml(order.ticket_number)} の取消を元に戻しました。</div>`;
      } });
    } catch (error) {
      submit.disabled = false;
      message.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    }
  };
  modal.showModal();
  if (cancellable) modal.querySelector("textarea").focus();
}

async function loadMenuButtons() {
  const target = document.querySelector("#menu-buttons");
  try {
    const [settings, result] = await Promise.all([api("/api/reception-settings"), api("/api/menu")]);
    state.receptionMode = settings.mode === "CART" ? "CART" : "DIRECT";
    state.menuItems = result.items || [];
    if (!state.menuItems.length) {
      target.innerHTML = `<div class="empty">管理画面でメニューを登録してください</div>`;
      return;
    }
    const toolbar = document.querySelector("#menu-toolbar");
    if (state.receptionMode === "CART") {
      toolbar.innerHTML = `<div class="toolbar-heading"><div><span class="step-label">STEP 1</span><h2>商品を選ぶ</h2></div><button class="primary add-menu-button" id="add-menu-button">＋ 商品を追加</button></div>`;
      target.innerHTML = `<div class="empty compact-empty">「商品を追加」から注文商品を選択してください</div>`;
      document.querySelector("#add-menu-button").onclick = openMenuPicker;
    } else {
      toolbar.innerHTML = `<div class="toolbar-heading"><div><span class="step-label">STEP 1</span><h2>商品を選ぶ</h2><p>商品を押して、味付けと個数を入力します。</p></div></div>`;
      target.innerHTML = state.menuItems.map((item) => `<button class="menu-button" data-item-id="${escapeHtml(item.id)}">${escapeHtml(item.name)}</button>`).join("");
    }
    target.querySelectorAll("[data-item-id]").forEach((button) => {
      button.onclick = () => openItemModal(state.menuItems.find((item) => item.id === button.dataset.itemId));
    });
    renderCart();
  } catch (error) {
    target.innerHTML = `<div class="error">メニューを読み込めません：${error.message}</div>`;
  }
}

function openMenuPicker() {
  const modal = document.querySelector("#item-modal");
  modal.innerHTML = `<div class="modal-card"><div class="modal-header"><h2>商品を追加</h2><button type="button" class="modal-close" aria-label="閉じる">×</button></div><div class="modal-menu-list">${state.menuItems.map((item) => `<button class="menu-button" data-picker-item="${escapeHtml(item.id)}">${escapeHtml(item.name)}</button>`).join("")}</div></div>`;
  modal.querySelector(".modal-close").onclick = () => modal.close();
  modal.querySelectorAll("[data-picker-item]").forEach((button) => { button.onclick = () => openItemModal(state.menuItems.find((item) => item.id === button.dataset.pickerItem)); });
  modal.showModal();
}

function openItemModal(item) {
  if (!item) return;
  const modal = document.querySelector("#item-modal");
  state.modalDraft = { item, quantity: 1 };
  renderItemModal();
  if (!modal.open) modal.showModal();
}

function renderItemModal() {
  const modal = document.querySelector("#item-modal");
  const item = state.modalDraft?.item;
  if (!modal || !item) return;
  const groups = (item.option_groups || []).filter((group) => group.options?.length);
  const optionGroups = groups.length ? `<div class="modal-options"><p class="modal-label">味付け・サブ項目</p>${groups.map((group) => `<fieldset class="modal-option-group"><legend>${escapeHtml(group.name)}${group.required ? `<span>必須</span>` : `<small>任意</small>`}</legend><div class="option-choices">${group.options.map((option) => { const key = `${group.id}:${option.id}`; return `<label class="option-choice"><input type="${group.selection_type === "SINGLE" ? "radio" : "checkbox"}" name="option-${escapeHtml(group.id)}" value="${escapeHtml(key)}" data-option-key="${escapeHtml(key)}" /><span>${escapeHtml(option.name)}</span></label>`; }).join("")}</div></fieldset>`).join("")}</div>` : "";
  const quantity = `<div class="modal-quantity"><p class="modal-label">数量</p><div class="quantity-control"><button type="button" data-modal-minus aria-label="数量を1つ減らす">−</button><strong data-modal-quantity>${state.modalDraft.quantity}</strong><button type="button" data-modal-plus aria-label="数量を1つ増やす">＋</button></div></div>`;
  modal.innerHTML = `<div class="modal-card"><div class="modal-header"><h2>${escapeHtml(item.name)}</h2><button type="button" class="modal-close" aria-label="閉じる">×</button></div>${optionGroups}${quantity}<div class="button-row"><button type="button" class="modal-close-action">キャンセル</button><button type="button" class="primary" id="add-to-cart">この内容を追加</button></div><div id="modal-message"></div></div>`;
  modal.querySelectorAll(".modal-close, .modal-close-action").forEach((button) => { button.onclick = () => modal.close(); });
  modal.querySelector("[data-modal-minus]").onclick = () => changeModalQuantity(-1);
  modal.querySelector("[data-modal-plus]").onclick = () => changeModalQuantity(1);
  modal.querySelector("#add-to-cart").onclick = addModalToCart;
}

function changeModalQuantity(change) {
  state.modalDraft.quantity = Math.min(999, Math.max(1, state.modalDraft.quantity + change));
  const quantity = document.querySelector("[data-modal-quantity]");
  if (quantity) quantity.textContent = String(state.modalDraft.quantity);
}

function addModalToCart() {
  const draft = state.modalDraft;
  if (!draft) return;
  const selectedOptionKeys = [...document.querySelectorAll("[data-option-key]:checked")].map((input) => input.dataset.optionKey);
  const built = buildOrderLine(draft.item, draft.quantity, selectedOptionKeys);
  if (!built.ok) {
    const message = built.error === "REQUIRED_OPTION_MISSING" ? `${built.groupName}を選択してください` : "味付け・サブ項目の選択を確認してください";
    document.querySelector("#modal-message").innerHTML = `<div class="error">${escapeHtml(message)}</div>`;
    return;
  }
  const addition = built.line;
  const key = JSON.stringify([addition.itemCode, addition.options]);
  const existing = state.cart.find((line) => line.key === key);
  if (existing) existing.quantity = Math.min(999, existing.quantity + addition.quantity);
  else state.cart.push({ ...addition, key });
  document.querySelector("#item-modal").close();
  state.modalDraft = null;
  renderCart();
}

function renderCart() {
  const target = document.querySelector("#cart-items");
  const submit = document.querySelector("#submit-order");
  if (!target || !submit) return;
  const total = state.cart.reduce((sum, line) => sum + line.quantity, 0);
  const count = document.querySelector("#cart-count");
  if (count) count.textContent = `${total}点`;
  target.innerHTML = state.cart.length ? state.cart.map((line, index) => `<div class="cart-line"><div class="cart-description"><strong>${escapeHtml(line.itemName)}</strong>${line.options.length ? `<div class="muted">${line.options.map((option) => `${escapeHtml(option.groupName)}：${escapeHtml(option.optionName)}`).join(" / ")}</div>` : ""}</div><div class="quantity-control compact"><button type="button" aria-label="${escapeHtml(line.itemName)}を1つ減らす" data-cart-minus="${index}">−</button><strong aria-label="数量${line.quantity}">${line.quantity}</strong><button type="button" aria-label="${escapeHtml(line.itemName)}を1つ増やす" data-cart-plus="${index}">＋</button></div><button type="button" class="text-danger cart-remove" data-cart-remove="${index}" aria-label="${escapeHtml(line.itemName)}を削除">削除</button></div>`).join("") : `<div class="cart-empty"><span aria-hidden="true">＋</span><strong>商品がまだありません</strong><small>左のメニューから商品を選んでください</small></div>`;
  submit.disabled = !state.cart.length;
  target.querySelectorAll("[data-cart-minus]").forEach((button) => { button.onclick = () => changeCartQuantity(Number(button.dataset.cartMinus), -1); });
  target.querySelectorAll("[data-cart-plus]").forEach((button) => { button.onclick = () => changeCartQuantity(Number(button.dataset.cartPlus), 1); });
  target.querySelectorAll("[data-cart-remove]").forEach((button) => { button.onclick = () => { state.cart.splice(Number(button.dataset.cartRemove), 1); renderCart(); }; });
}

function changeCartQuantity(index, change) {
  const line = state.cart[index];
  if (!line) return;
  line.quantity += change;
  if (line.quantity <= 0) state.cart.splice(index, 1);
  renderCart();
}

function updateSubmitState() {
  const submit = document.querySelector("#submit-order");
  if (!submit) return;
  submit.disabled = !state.cart.length || state.receptionSubmitting;
}

async function submitReception() {
  const message = document.querySelector("#reception-message");
  if (!state.eventId) { message.innerHTML = `<div class="error">管理画面で営業日を開始してください</div>`; return; }
  if (!state.cart.length || state.receptionSubmitting) return;
  if (!navigator.onLine && !isOfflineDeviceAuthValid({ role: state.deviceRole, expectedRole: "RECEPTION", reauthGraceExpiresAt: state.deviceReauthGraceExpiresAt })) {
    await ensureDeviceRole("RECEPTION", reception);
    return;
  }
  state.receptionSubmitting = true;
  updateSubmitState();
  const input = {
    eventId: state.eventId,
    mode: navigator.onLine ? "ONLINE" : "OFFLINE",
    acceptedAt: serverAdjustedIsoNow(state.serverClockOffsetMs),
    requestId: createClientId(),
    items: state.cart.map((line) => ({ itemCode: line.itemCode, itemName: line.itemName, quantity: line.quantity, options: line.options })),
  };
  try {
    let result;
    let queued = false;
    if (navigator.onLine) {
      try {
        result = await api("/api/orders", { method: "POST", body: JSON.stringify(input) });
      } catch (error) {
        const offlineAuthValid = isOfflineDeviceAuthValid({ role: state.deviceRole, expectedRole: "RECEPTION", reauthGraceExpiresAt: state.deviceReauthGraceExpiresAt });
        if (!isNetworkUnavailable(error) || !offlineAuthValid) throw error;
        result = await saveOfflineOrder(input);
        queued = true;
      }
    } else {
      result = await saveOfflineOrder(input);
      queued = true;
    }
    message.replaceChildren();
    state.cart = [];
    renderCart();
    if (queued) await refreshPendingSyncStatus("waiting");
    const undoOperationId = result.undoOperationId || input.requestId;
    offerUndo({
      operationId: undoOperationId,
      expiresAt: result.undoExpiresAt,
      label: `${queued ? "オフライン注文" : `受付番号 ${result.order.ticket_number}`} の確定を元に戻す`,
      run: queued ? async () => { await deletePendingOrder(input.requestId); await refreshPendingSyncStatus(); } : undefined,
      onUndone: async () => {
        document.querySelector("#reception-receipt-modal")?.close();
        message.innerHTML = `<div class="success-message">直前の注文確定を元に戻しました。</div>`;
      },
    });
    openReceiptDialog(result.order.ticket_number, queued, input.items);
  } catch (error) {
    message.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
  } finally {
    state.receptionSubmitting = false;
    updateSubmitState();
  }
}

function openReceiptDialog(ticketNumber, queued, items) {
  const modal = document.querySelector("#reception-receipt-modal");
  if (!modal) return;
  modal.innerHTML = `<div class="modal-card receipt-modal-card"><div class="receipt-confirmation ${queued ? "offline-receipt" : ""}"><span>${queued ? "オフライン番号" : "受付番号"}</span><strong>${escapeHtml(ticketNumber)}</strong>${queued ? `<p>この注文は端末に保存されています。必要なら内容を調理へ伝えてください。</p><ul>${renderReceiptItems(items)}</ul><small>通信復旧後に自動送信します。</small>` : `<small>この番号を紙に書いてお客様へお渡しください。</small>`}</div><div class="receipt-modal-actions"><button type="button" class="secondary-action" id="receipt-undo">注文確定を元に戻す</button><button type="button" class="primary" id="receipt-ok">OK</button></div><small class="receipt-undo-note">元に戻せるのは確定後10秒以内です。</small></div>`;
  modal.querySelector("#receipt-ok").onclick = () => modal.close();
  modal.querySelector("#receipt-undo").onclick = async (event) => {
    event.currentTarget.disabled = true;
    if (await performUndoAction()) modal.close();
  };
  modal.showModal();
}

function renderReceiptItems(items) {
  return items.map((item) => {
    const options = (item.options || []).map((option) => `${escapeHtml(option.groupName)}：${escapeHtml(option.optionName)}`).join("、");
    return `<li><strong>${escapeHtml(item.itemName)} ×${escapeHtml(item.quantity)}</strong>${options ? `<small>${options}</small>` : ""}</li>`;
  }).join("");
}

function openOfflineDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("order-system-offline", 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("pending-orders")) request.result.createObjectStore("pending-orders", { keyPath: "requestId" });
      if (!request.result.objectStoreNames.contains("offline-counters")) request.result.createObjectStore("offline-counters", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveOfflineOrder(input) {
  const settings = JSON.parse(localStorage.getItem("order-system:number-settings") || '{"offlinePrefix":"OFF-","offlineStartNumber":1000}');
  const database = await openOfflineDb();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(["pending-orders", "offline-counters"], "readwrite");
    const counterStore = transaction.objectStore("offline-counters");
    const read = counterStore.get("default");
    read.onsuccess = () => {
      const nextNumber = Math.max(read.result?.nextNumber || 0, settings.offlineStartNumber);
      Object.assign(input, prepareOfflineOrder(input, settings.offlinePrefix, nextNumber));
      counterStore.put({ id: "default", nextNumber: nextNumber + 1 });
      transaction.objectStore("pending-orders").put(input);
    };
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
  return { order: { ticket_number: input.ticketNumber } };
}

async function readPendingOrders() {
  const database = await openOfflineDb();
  try {
    const pending = await new Promise((resolve, reject) => {
      const request = database.transaction("pending-orders").objectStore("pending-orders").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return sortPendingOrders(pending);
  } finally {
    database.close();
  }
}

async function deletePendingOrder(requestId) {
  const database = await openOfflineDb();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("pending-orders", "readwrite");
      transaction.objectStore("pending-orders").delete(requestId);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

async function refreshPendingSyncStatus(status = "waiting", detail = "") {
  const target = document.querySelector("#pending-sync-status");
  if (!target) return 0;
  let pending;
  try {
    pending = await readPendingOrders();
  } catch {
    target.hidden = false;
    target.className = "pending-sync-status failed";
    target.innerHTML = `<strong>未送信注文を確認できません</strong><small>この端末の保存領域を確認してください。</small>`;
    return 0;
  }
  const count = pending.length;
  if (!count) {
    target.hidden = true;
    target.replaceChildren();
    return 0;
  }
  const labels = {
    syncing: "未送信注文を送信中",
    failed: "未送信注文を送信できません",
    waiting: navigator.onLine ? "未送信注文があります" : "通信復旧後に自動送信します",
  };
  target.hidden = false;
  target.className = `pending-sync-status ${status}`;
  target.innerHTML = `<div><strong>${escapeHtml(labels[status] || labels.waiting)}：${count}件</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}</div>${status === "failed" ? `<button type="button" class="secondary-action" id="retry-pending-sync">再送する</button>` : ""}`;
  const retry = target.querySelector("#retry-pending-sync");
  if (retry) retry.onclick = () => { void syncPendingOrders(); };
  return count;
}

async function syncPendingOrders() {
  if (!state.eventId) return;
  const pending = await readPendingOrders().catch(() => null);
  if (!pending) {
    await refreshPendingSyncStatus("failed", "端末の保存領域を読み取れません。");
    return;
  }
  if (!pending.length) {
    await refreshPendingSyncStatus();
    return;
  }
  if (!navigator.onLine) {
    await refreshPendingSyncStatus("waiting");
    return;
  }
  await refreshPendingSyncStatus("syncing");
  try {
    const database = await openOfflineDb();
    try {
      for (const order of pending) {
        await api("/api/orders", { method: "POST", body: JSON.stringify(order) });
        await new Promise((resolve, reject) => { const transaction = database.transaction("pending-orders", "readwrite"); transaction.objectStore("pending-orders").delete(order.requestId); transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
      }
    } finally {
      database.close();
    }
    await refreshPendingSyncStatus();
    const message = document.querySelector("#reception-message");
    if (message) {
      const ticketSummary = pending.length === 1
        ? `：${escapeHtml(pending[0].ticketNumber)}`
        : `：${pending.length}件`;
      message.innerHTML = `<div class="success-message">未送信注文を送信しました${ticketSummary}</div>`;
    }
  } catch (error) {
    await refreshPendingSyncStatus("failed", error.message || "通信状態を確認して再送してください。");
  }
}

async function kitchen() {
  if (!await ensureDeviceRole("KITCHEN", kitchen)) return;
  layout("調理", "表示された注文を作り、完了ボタンを押してください。", `<div class="kitchen-topbar"><div class="screen-status">${eventPanel()}</div><div class="kitchen-tools"><div class="queue-count kitchen-queue-count"><strong id="kitchen-waiting-count">−</strong><span>待機注文</span></div><div class="kitchen-presence" id="kitchen-presence"><span id="kitchen-presence-label">状態確認中</span><button type="button" class="secondary-action" id="kitchen-presence-toggle">離席する</button></div><button type="button" class="secondary-action kitchen-sound-toggle" id="kitchen-sound-toggle"><span aria-hidden="true">♪</span><span id="kitchen-sound-label">通知音</span></button>${deviceBadge()}</div></div><div id="kitchen-sound-message" class="kitchen-sound-message" role="status"></div><div id="kitchen-order" class="kitchen-stage"><div class="empty"><span class="loading-dot"></span>次の注文を確認しています</div></div><dialog id="kitchen-away-modal"></dialog>`, { screen: "kitchen", context: "調理端末", eyebrow: "KITCHEN" });
  bindDeviceChange();
  bindKitchenSound();
  bindKitchenPresence();
  restoreKitchenOfflineState();
  await loadCurrentEvent();
  startCurrentEventSync();
  subscribeRealtime();
  if (await syncPendingKitchenCompletion()) await loadNextKitchen();
  state.refreshTimer = window.setInterval(() => {
    if (document.visibilityState !== "hidden") void loadNextKitchen();
  }, FAST_KITCHEN_REFRESH_MS);
}

function restoreKitchenOfflineState() {
  state.kitchenPendingCompletion = loadPendingKitchenCompletion(localStorage, state.deviceId);
  if (state.kitchenPendingCompletion) {
    state.kitchenOrder = null;
    renderPendingKitchenCompletion();
    return true;
  }
  return restoreCachedKitchenAssignment();
}

function restoreCachedKitchenAssignment() {
  const cached = loadKitchenAssignment(localStorage, { eventId: state.eventId, deviceId: state.deviceId });
  if (!cached) return false;
  state.kitchenOrder = cached.assignment;
  state.kitchenAway = cached.away;
  state.kitchenLastSeenOrderId = cached.assignment.id;
  renderKitchenPresence();
  renderKitchenOrder();
  showKitchenStaleWarning("オフラインのため、直前に担当していた商品を表示しています。通信復旧後に自動確認します。");
  return true;
}

function showKitchenStaleWarning(message) {
  const target = document.querySelector("#kitchen-order");
  if (!target) return;
  target.querySelector(".kitchen-stale-warning")?.remove();
  target.insertAdjacentHTML("afterbegin", `<div class="stale-data-warning kitchen-stale-warning" role="status"><strong>最新状態を確認できません</strong><span>${escapeHtml(message)}</span></div>`);
}

function renderPendingKitchenCompletion(syncError = "") {
  const target = document.querySelector("#kitchen-order");
  const pending = state.kitchenPendingCompletion;
  if (!target || !pending) return;
  target.dataset.kitchenOrderId = PENDING_KITCHEN_COMPLETION_RENDER_ID;
  target.innerHTML = `<div class="kitchen-waiting unavailable kitchen-completion-pending"><span class="waiting-mark" aria-hidden="true">✓</span><h2>受付番号 ${escapeHtml(pending.ticketNumber)} は調理完了として保存しました</h2><p>オンライン復帰後に完了状態を自動で同期します。</p><div class="warning-message"><strong>次の注文はまだ確認できません。</strong><span>オンライン復帰を待つか、受付・管理担当へ直接聞いて確認してください。</span></div>${syncError ? `<div class="error">${escapeHtml(syncError)}</div>` : ""}${navigator.onLine ? `<button type="button" class="secondary-action" id="retry-kitchen-completion-sync">今すぐ同期</button>` : ""}</div>`;
  const retry = document.querySelector("#retry-kitchen-completion-sync");
  if (retry) retry.onclick = async () => { retry.disabled = true; if (await syncPendingKitchenCompletion()) await loadNextKitchen(); };
}

function queuePendingKitchenCompletion(order, operationId, source) {
  const completion = {
    eventId: state.eventId,
    deviceId: state.deviceId,
    orderId: order.id,
    ticketNumber: order.ticket_number,
    operationId,
    source,
    completedAt: new Date().toISOString(),
  };
  if (!savePendingKitchenCompletion(localStorage, completion)) throw new Error("調理完了状態を端末に保存できませんでした。");
  state.kitchenPendingCompletion = completion;
  state.kitchenOrder = null;
  clearKitchenAssignment(localStorage, { eventId: state.eventId, deviceId: state.deviceId });
  renderKitchenPresence();
  renderPendingKitchenCompletion();
}

async function syncPendingKitchenCompletion() {
  const pending = state.kitchenPendingCompletion || loadPendingKitchenCompletion(localStorage, state.deviceId);
  state.kitchenPendingCompletion = pending;
  if (!pending) return true;
  if (!navigator.onLine) { renderPendingKitchenCompletion(); return false; }
  try {
    await api(`/api/orders/${pending.orderId}/ready`, {
      method: "POST",
      body: JSON.stringify({ deviceId: pending.deviceId, operationId: pending.operationId, source: pending.source || "offline-sync" }),
    });
    clearPendingKitchenCompletion(localStorage, pending.deviceId);
    state.kitchenPendingCompletion = null;
    return true;
  } catch (error) {
    renderPendingKitchenCompletion(`${error.message} 完了状態は端末に保存されたままです。`);
    return false;
  }
}

const kitchenCompletionKeyGuard = createKitchenCompletionKeyGuard();
document.addEventListener("keyup", (event) => kitchenCompletionKeyGuard.release(event));
document.addEventListener("keydown", (event) => {
  if (document.body.dataset.screen !== "kitchen" || !["Enter", " ", "Spacebar"].includes(event.key)) return;
  if (isKeyboardShortcutTarget(event.target) || document.querySelector("dialog[open]")) return;
  event.preventDefault();
  const eligible = Boolean(state.kitchenOrder) && !state.kitchenCompletionInFlight;
  if (kitchenCompletionKeyGuard.shouldTrigger(event, eligible)) void completeKitchenOrder("keyboard");
});

function renderKitchenPresence() {
  const container = document.querySelector("#kitchen-presence");
  const label = document.querySelector("#kitchen-presence-label");
  const button = document.querySelector("#kitchen-presence-toggle");
  if (!container || !label || !button) return;
  const leavingAfterCurrent = state.kitchenAway && Boolean(state.kitchenOrder);
  container.dataset.state = leavingAfterCurrent ? "leaving" : state.kitchenAway ? "away" : "active";
  label.textContent = leavingAfterCurrent ? "この注文後に離席" : state.kitchenAway ? "離席中" : "稼働中";
  button.textContent = state.kitchenAway ? "離席を解除" : "離席する";
}

async function setKitchenPresence(payload) {
  const operationId = createClientId();
  const result = await api("/api/kitchen/presence", {
    method: "POST",
    body: JSON.stringify({ eventId: state.eventId, deviceId: state.deviceId, operationId, ...payload }),
  });
  state.kitchenAway = Boolean(result.away);
  state.kitchenOrder = result.assignment || null;
  if (state.kitchenOrder) saveKitchenAssignment(localStorage, { eventId: state.eventId, deviceId: state.deviceId, assignment: state.kitchenOrder, away: state.kitchenAway });
  else clearKitchenAssignment(localStorage, { eventId: state.eventId, deviceId: state.deviceId });
  const count = document.querySelector("#kitchen-waiting-count");
  if (count) count.textContent = String(result.waitingCount ?? 0);
  renderKitchenPresence();
  renderKitchenOrder();
  offerUndo({ operationId: result.undoOperationId || operationId, expiresAt: result.undoExpiresAt, label: payload.away ? "離席操作を元に戻す" : "離席解除を元に戻す", onUndone: loadNextKitchen });
  return result;
}

function bindKitchenPresence() {
  const button = document.querySelector("#kitchen-presence-toggle");
  if (!button) return;
  button.onclick = async () => {
    button.disabled = true;
    try {
      if (state.kitchenAway) {
        await setKitchenPresence({ away: false });
        await loadNextKitchen();
      } else {
        openKitchenAwayDialog();
      }
    } catch (error) {
      window.alert(error.message);
    } finally {
      button.disabled = false;
    }
  };
}

function openKitchenAwayDialog() {
  const modal = document.querySelector("#kitchen-away-modal");
  if (!modal) return;
  const ticket = state.kitchenOrder?.ticket_number;
  modal.innerHTML = state.kitchenOrder
    ? `<div class="modal-card kitchen-away-dialog"><div class="modal-header"><div><span class="step-label">KITCHEN PRESENCE</span><h2>受付番号 ${escapeHtml(ticket)} の扱いを確認</h2></div><button type="button" class="modal-close" aria-label="閉じる">×</button></div><div class="away-choice"><strong>まだ調理を開始していない場合</strong><p>注文を調理待ちへ戻して、この端末を離席中にします。</p><label class="confirmation-check"><input type="checkbox" id="confirm-unstarted" /> この商品の調理をまだ開始していません</label><button type="button" class="danger" id="requeue-and-away" disabled>調理待ちへ戻して離席</button></div><div class="away-choice"><strong>すでに調理を開始している場合</strong><p>この注文は担当したままにし、完了後に次の商品を受け取らず離席します。</p><button type="button" class="secondary-action" id="finish-and-away">この注文の完了後に離席</button></div><div id="kitchen-away-message" aria-live="assertive"></div></div>`
    : `<div class="modal-card kitchen-away-dialog"><div class="modal-header"><div><span class="step-label">KITCHEN PRESENCE</span><h2>離席しますか？</h2></div><button type="button" class="modal-close" aria-label="閉じる">×</button></div><p>離席中は新しい注文が割り当てられません。</p><button type="button" class="danger" id="away-now">離席状態にする</button><div id="kitchen-away-message" aria-live="assertive"></div></div>`;
  const close = () => modal.close();
  modal.querySelector(".modal-close").onclick = close;
  const run = async (button, payload) => {
    button.disabled = true;
    try { await setKitchenPresence(payload); close(); }
    catch (error) { modal.querySelector("#kitchen-away-message").innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`; button.disabled = false; }
  };
  const checkbox = modal.querySelector("#confirm-unstarted");
  const requeueButton = modal.querySelector("#requeue-and-away");
  if (checkbox && requeueButton) {
    checkbox.onchange = () => { requeueButton.disabled = !checkbox.checked; };
    requeueButton.onclick = () => run(requeueButton, { away: true, mode: "REQUEUE_UNSTARTED", confirmedUnstarted: true });
  }
  const finishButton = modal.querySelector("#finish-and-away");
  if (finishButton) finishButton.onclick = () => run(finishButton, { away: true, mode: "FINISH_CURRENT" });
  const awayNowButton = modal.querySelector("#away-now");
  if (awayNowButton) awayNowButton.onclick = () => run(awayNowButton, { away: true });
  modal.showModal();
}

function kitchenAudioConstructor() {
  return window.AudioContext || window.webkitAudioContext || null;
}

function updateKitchenSoundUi() {
  const button = document.querySelector("#kitchen-sound-toggle");
  const label = document.querySelector("#kitchen-sound-label");
  if (!button || !label) return;
  const view = kitchenAlertButtonState({
    supported: Boolean(kitchenAudioConstructor()),
    preferred: state.kitchenSoundPreferred,
    ready: state.kitchenSoundReady,
  });
  label.textContent = view.label;
  button.ariaPressed = String(view.pressed);
  button.dataset.tone = view.tone;
  button.disabled = view.tone === "unavailable";
}

function bindKitchenSound() {
  const button = document.querySelector("#kitchen-sound-toggle");
  if (!button) return;
  updateKitchenSoundUi();
  button.onclick = async () => {
    button.disabled = true;
    const message = document.querySelector("#kitchen-sound-message");
    try {
      if (state.kitchenSoundReady) {
        await state.kitchenAudioContext?.close();
        state.kitchenAudioContext = null;
        state.kitchenSoundReady = false;
        state.kitchenSoundPreferred = false;
        localStorage.removeItem("order-system:kitchen-sound");
        if (message) message.textContent = "通知音をオフにしました。";
      } else {
        const AudioContextConstructor = kitchenAudioConstructor();
        if (!AudioContextConstructor) throw new Error("このブラウザは通知音に対応していません。");
        const existingContext = state.kitchenAudioContext?.state === "closed" ? null : state.kitchenAudioContext;
        state.kitchenAudioContext = existingContext || new AudioContextConstructor();
        await state.kitchenAudioContext.resume();
        if (state.kitchenAudioContext.state !== "running") throw new Error("音声を開始できませんでした。もう一度押してください。");
        state.kitchenSoundPreferred = true;
        state.kitchenSoundReady = true;
        localStorage.setItem("order-system:kitchen-sound", "on");
        await playKitchenAlertTone();
        if (message) message.textContent = "通知音をオンにしました。新しい注文でこの音が鳴ります。";
      }
    } catch (error) {
      state.kitchenSoundReady = false;
      if (message) message.textContent = error.message;
    } finally {
      updateKitchenSoundUi();
    }
  };
}

async function playKitchenAlertTone() {
  const context = state.kitchenAudioContext;
  if (!context || !state.kitchenSoundReady) return;
  if (context.state === "suspended") await context.resume();
  if (context.state !== "running") throw new Error("通知音を再開できませんでした。通知音を準備し直してください。");

  const start = context.currentTime + 0.02;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(880, start);
  oscillator.frequency.setValueAtTime(1174, start + 0.16);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.18, start + 0.015);
  gain.gain.setValueAtTime(0.18, start + 0.26);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.34);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.addEventListener("ended", () => { oscillator.disconnect(); gain.disconnect(); }, { once: true });
  oscillator.start(start);
  oscillator.stop(start + 0.35);
}

function notifyKitchenAssignment(previousOrderId, nextOrderId) {
  if (!shouldPlayKitchenAlert({
    previousOrderId,
    nextOrderId,
    preferred: state.kitchenSoundPreferred,
    ready: state.kitchenSoundReady,
  })) return;
  void playKitchenAlertTone().then(() => {
    const message = document.querySelector("#kitchen-sound-message");
    if (message) message.textContent = "新しい注文を通知音でお知らせしました。";
  }).catch((error) => {
    state.kitchenSoundReady = false;
    updateKitchenSoundUi();
    const message = document.querySelector("#kitchen-sound-message");
    if (message) message.textContent = error.message;
  });
}

async function loadNextKitchen() {
  const target = document.querySelector("#kitchen-order");
  if (!target) return;
  if (state.kitchenPendingCompletion && !await syncPendingKitchenCompletion()) return;
  if (!state.eventId) { const count = document.querySelector("#kitchen-waiting-count"); if (count) count.textContent = "0"; delete target.dataset.kitchenOrderId; target.innerHTML = `<div class="kitchen-waiting unavailable"><span class="waiting-mark" aria-hidden="true">!</span><h2>営業開始前です</h2><p>管理画面で営業日を開始してください。</p></div>`; return; }
  if (!state.deviceId) { delete target.dataset.kitchenOrderId; target.innerHTML = `<div class="kitchen-waiting unavailable"><span class="waiting-mark" aria-hidden="true">!</span><h2>端末IDが必要です</h2><p>上の「使用端末」から端末IDを設定してください。</p></div>`; return; }
  const requestGeneration = ++state.kitchenRequestGeneration;
  try {
    const result = await api("/api/kitchen/next", { method: "POST", body: JSON.stringify({ eventId: state.eventId, deviceId: state.deviceId, operationId: createClientId(), knownOrderId: state.kitchenOrder?.id }) });
    if (requestGeneration !== state.kitchenRequestGeneration || !document.querySelector("#kitchen-order")) return;
    const previousOrderId = state.kitchenLastSeenOrderId;
    const assignment = result.assignmentUnchanged && result.assignmentId === state.kitchenOrder?.id
      ? state.kitchenOrder
      : result.assignment;
    const nextOrderId = assignment?.id || null;
    const renderedOrderId = target.dataset.kitchenOrderId;
    const shouldRender = renderedOrderId === undefined || (renderedOrderId || null) !== nextOrderId;
    state.kitchenOrder = assignment;
    state.kitchenAway = Boolean(result.away);
    const waitingCount = document.querySelector("#kitchen-waiting-count");
    if (waitingCount) waitingCount.textContent = String(result.waitingCount ?? 0);
    state.kitchenLastSeenOrderId = nextOrderId;
    if (assignment) saveKitchenAssignment(localStorage, { eventId: state.eventId, deviceId: state.deviceId, assignment, away: state.kitchenAway });
    else clearKitchenAssignment(localStorage, { eventId: state.eventId, deviceId: state.deviceId });
    renderKitchenPresence();
    if (shouldRender) renderKitchenOrder();
    notifyKitchenAssignment(previousOrderId, nextOrderId);
  } catch (error) {
    if (requestGeneration !== state.kitchenRequestGeneration) return;
    if (state.kitchenOrder) {
      if (target.dataset.kitchenOrderId !== state.kitchenOrder.id) renderKitchenOrder();
      showKitchenStaleWarning(`${error.message} 表示中の商品は担当したままです。`);
    } else {
      delete target.dataset.kitchenOrderId;
      target.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    }
  }
}

function renderKitchenOrder() {
  const target = document.querySelector("#kitchen-order");
  target.dataset.kitchenOrderId = state.kitchenOrder?.id || "";
  if (!state.kitchenOrder) {
    if (state.kitchenAway) { target.innerHTML = `<div class="kitchen-waiting kitchen-away-state"><span class="waiting-mark" aria-hidden="true">休</span><h2>離席中</h2><p>新しい注文は割り当てられません。戻ったら「離席を解除」を押してください。</p></div>`; return; }
    target.innerHTML = `<div class="kitchen-waiting"><span class="waiting-mark" aria-hidden="true">✓</span><h2>待機中</h2><p>新しい注文が入ると自動で表示します。</p><button class="secondary-action" id="retry-kitchen">今すぐ確認</button></div>`; document.querySelector("#retry-kitchen").onclick = loadNextKitchen; return;
  }
  const items = (state.kitchenOrder.items || []).map((item) => `<li><span>${escapeHtml(item.item_name)}${item.options?.length ? `<small class="kitchen-options">${item.options.map((option) => `<span class="${option.required ? "required-kitchen-option" : "optional-kitchen-option"}">${option.required ? `<b>必須</b>` : ""}${escapeHtml(option.group_name)}：${escapeHtml(option.option_name)}</span>`).join("")}</small>` : ""}</span><span>×${item.quantity}</span></li>`).join("");
  target.innerHTML = `<article class="kitchen-order-card"><div class="ticket-label">受付番号</div><div class="order-number">${escapeHtml(state.kitchenOrder.ticket_number)}</div><ul class="order-items">${items}</ul><div class="kitchen-action">${state.kitchenAway ? `<div class="leaving-notice">この注文を完了すると離席状態になります。次の商品は入りません。</div>` : ""}<button class="success" id="ready-order"><span aria-hidden="true">✓</span><strong>調理完了</strong><small>${state.kitchenAway ? "完了後に離席します" : "押すと次の注文へ進みます"}</small></button><div class="kitchen-key-hint"><kbd>Space</kbd><span>または</span><kbd>Enter</kbd><span>でも完了</span></div></div></article>`;
  document.querySelector("#ready-order").onclick = () => { void completeKitchenOrder("button"); };
}

async function completeKitchenOrder(source) {
  const order = state.kitchenOrder;
  const button = document.querySelector("#ready-order");
  if (!order || state.kitchenCompletionInFlight || Date.now() < state.kitchenCompletionBlockedUntil) return;
  state.kitchenCompletionInFlight = true;
  state.kitchenCompletionBlockedUntil = Date.now() + 2_000;
  if (button) button.disabled = true;
  const operationId = createClientId();
  try {
    if (!navigator.onLine) {
      queuePendingKitchenCompletion(order, operationId, source);
      return;
    }
    const result = await api(`/api/orders/${order.id}/ready`, { method: "POST", body: JSON.stringify({ deviceId: state.deviceId, operationId, source }) });
    if (state.kitchenOrder?.id === order.id) {
      state.kitchenOrder = null;
      clearKitchenAssignment(localStorage, { eventId: state.eventId, deviceId: state.deviceId });
    }
    await loadNextKitchen();
    offerUndo({ operationId: result.undoOperationId || operationId, expiresAt: result.undoExpiresAt, label: `受付番号 ${order.ticket_number} の調理完了を元に戻す`, onUndone: loadNextKitchen });
  } catch (error) {
    if (isNetworkUnavailable(error)) {
      queuePendingKitchenCompletion(order, operationId, source);
      return;
    }
    if (button) button.disabled = false;
    const action = document.querySelector("#ready-order")?.closest(".kitchen-action");
    action?.querySelector(".operation-error")?.remove();
    action?.insertAdjacentHTML("afterbegin", `<div class="error operation-error">${escapeHtml(error.message)} もう一度操作してください。</div>`);
  } finally {
    state.kitchenCompletionInFlight = false;
  }
}

async function delivery() { if (!await ensureDeviceRole("DELIVERY", delivery)) return; layout("受け渡し", "番号を確認して商品を渡し、提供済みにしてください。", `<div class="delivery-toolbar"><div class="screen-status">${eventPanel()}</div><div class="queue-count"><strong id="ready-count">−</strong><span>受け渡し待ち</span></div>${deviceBadge()}</div><div id="delivery-sync-status" class="stale-data-warning" role="status" hidden></div><div id="ready-orders" class="delivery-grid"><div class="empty"><span class="loading-dot"></span>受け渡し待ちを確認しています</div></div>`, { screen: "delivery", context: "受け渡し端末", eyebrow: "DELIVERY" }); bindDeviceChange(); await loadCurrentEvent(); startCurrentEventSync(); subscribeRealtime(); loadReadyOrders(); state.refreshTimer = window.setInterval(() => { if (document.visibilityState !== "hidden") void loadReadyOrders(); }, FALLBACK_REFRESH_MS); }
async function loadReadyOrders() {
  const target = document.querySelector("#ready-orders");
  const syncStatus = document.querySelector("#delivery-sync-status");
  if (!target) return;
  if (!state.eventId) {
    document.querySelector("#ready-count").textContent = "0";
    target.innerHTML = `<div class="delivery-empty unavailable"><span aria-hidden="true">!</span><h2>営業開始前です</h2><p>管理画面で営業日を開始してください。</p></div>`;
    return;
  }
  try {
    const result = await api(`/api/delivery/ready?eventId=${encodeURIComponent(state.eventId)}`);
    if (syncStatus) { syncStatus.hidden = true; syncStatus.replaceChildren(); }
    const orders = result.orders || [];
    const count = document.querySelector("#ready-count");
    if (count) count.textContent = String(orders.length);
    target.innerHTML = orders.length ? orders.map((order) => `<article class="delivery-card"><span class="ready-label"><span aria-hidden="true">●</span> お渡しできます</span><div class="order-number">${escapeHtml(order.ticket_number)}</div>${renderOrderItems(order.items)}<div class="delivery-card-actions"><button class="secondary-action" data-rework="${escapeHtml(order.id)}" data-ticket-number="${escapeHtml(order.ticket_number)}">調理中に戻す</button><button class="success" data-complete="${escapeHtml(order.id)}"><span aria-hidden="true">✓</span> 提供済みにする</button></div></article>`).join("") : `<div class="delivery-empty"><span aria-hidden="true">✓</span><h2>すべて受け渡し済みです</h2><p>新しい注文が完成すると自動で表示します。</p></div>`;
    target.querySelectorAll("[data-complete]").forEach((button) => {
      button.onclick = async () => {
        button.disabled = true;
        try {
          const operationId = createClientId();
          const ticketNumber = button.closest(".delivery-card")?.querySelector(".order-number")?.textContent?.trim() || "注文";
          const result = await api(`/api/orders/${button.dataset.complete}/complete`, { method: "POST", body: JSON.stringify({ deviceId: state.deviceId, operationId }) });
          await loadReadyOrders();
          offerUndo({ operationId: result.undoOperationId || operationId, expiresAt: result.undoExpiresAt, label: `受付番号 ${ticketNumber} の提供完了を元に戻す`, onUndone: loadReadyOrders });
        } catch (error) {
          button.disabled = false;
          const card = button.closest(".delivery-card");
          card.querySelector(".operation-error")?.remove();
          button.insertAdjacentHTML("beforebegin", `<div class="error operation-error">${escapeHtml(error.message)} もう一度押してください。</div>`);
        }
      };
    });
    target.querySelectorAll("[data-rework]").forEach((button) => {
      button.onclick = async () => {
        if (!window.confirm(`受付番号 ${button.dataset.ticketNumber} を前の調理担当端末へ戻しますか？\n担当端末に別の注文がある場合、その注文は調理待ちへ戻ります。`)) return;
        const card = button.closest(".delivery-card");
        card.querySelectorAll("button").forEach((candidate) => { candidate.disabled = true; });
        try {
          const operationId = createClientId();
          const result = await api(`/api/delivery/orders/${encodeURIComponent(button.dataset.rework)}/rework`, { method: "POST", body: JSON.stringify({ deviceId: state.deviceId, operationId }) });
          await loadReadyOrders();
          offerUndo({ operationId: result.undoOperationId || operationId, expiresAt: result.undoExpiresAt, label: `受付番号 ${button.dataset.ticketNumber} の調理戻しを元に戻す`, onUndone: loadReadyOrders });
        } catch (error) {
          card.querySelectorAll("button").forEach((candidate) => { candidate.disabled = false; });
          card.querySelector(".operation-error")?.remove();
          card.querySelector(".delivery-card-actions").insertAdjacentHTML("beforebegin", `<div class="error operation-error">${escapeHtml(error.message)}</div>`);
        }
      };
    });
  } catch (error) {
    if (syncStatus) {
      syncStatus.hidden = false;
      syncStatus.innerHTML = `<strong>最新状態を取得できません</strong><span>${escapeHtml(error.message)} 表示中の内容は通信断前の状態です。</span>`;
    }
    if (!target.querySelector(".delivery-card")) target.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
  }
}

function publicOrderStatus() {
  layout("注文状況を確認", "受付で受け取った番号を入力してください。", `<section class="panel public-status-panel"><form id="public-status-form" class="ticket-lookup-form"><label>受付番号<input name="ticketNumber" inputmode="text" maxlength="64" required autocomplete="off" placeholder="例：100" /></label><button type="submit" class="primary">状況を確認</button></form><div id="public-status-result" class="public-status-result" aria-live="polite"><div class="empty">受付番号を入力すると、現在の状況を表示します。</div></div></section>`, { screen: "status", context: "お客様用・注文状況", eyebrow: "MY ORDER" });
  const form = document.querySelector("#public-status-form");
  form.onsubmit = async (event) => {
    event.preventDefault();
    state.publicTicketNumber = String(new FormData(form).get("ticketNumber") || "").trim();
    const status = await loadPublicOrderStatus();
    if (state.refreshTimer) window.clearInterval(state.refreshTimer);
    state.refreshTimer = null;
    if (!["WAITING", "COOKING"].includes(status)) return;
    state.refreshTimer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void loadPublicOrderStatus(true);
    }, FALLBACK_REFRESH_MS);
  };
}

async function loadPublicOrderStatus(silent = false) {
  const target = document.querySelector("#public-status-result");
  if (!target || !state.publicTicketNumber) return;
  if (!silent) target.innerHTML = `<div class="empty"><span class="loading-dot"></span>状況を確認しています</div>`;
  try {
    const result = await api(`/api/public/order-status?ticketNumber=${encodeURIComponent(state.publicTicketNumber)}`);
    const order = result.order;
    const labels = { WAITING: "調理待ち", COOKING: "調理中", READY: "お渡しできます", COMPLETED: "提供済み", CANCELLED: "取消済み" };
    const messages = { WAITING: "順番に調理しています。", COOKING: "ただいま調理しています。", READY: "受け渡し口までお越しください。", COMPLETED: "商品の受け渡しが完了しています。", CANCELLED: "この注文は取り消されています。" };
    const queue = order.status === "WAITING" ? `<div class="public-queue-stats"><div><strong>${order.ordersAhead}</strong><span>前にある注文</span></div><div><strong>${order.itemsAhead}</strong><span>前にある商品</span></div></div>` : "";
    const terminal = ["READY", "COMPLETED", "CANCELLED"].includes(order.status);
    if (terminal && state.refreshTimer) {
      window.clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
    target.innerHTML = `<article class="public-order-result status-${escapeHtml(order.status.toLowerCase())}"><span>受付番号</span><strong class="public-ticket-number">${escapeHtml(order.ticketNumber)}</strong><h2>${escapeHtml(labels[order.status] || order.status)}</h2><p>${escapeHtml(messages[order.status] || "現在の状況をご確認ください。")}</p>${queue}<small>${terminal ? "自動更新は終了しました。" : "この画面は30秒ごとに更新されます。"}</small><button type="button" class="secondary-action" id="refresh-public-status">今すぐ更新</button></article>`;
    document.querySelector("#refresh-public-status").onclick = () => { void loadPublicOrderStatus(); };
    return order.status;
  } catch (error) {
    if (!silent || error.code === "ORDER_NOT_FOUND") target.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    return null;
  }
}

async function display() { if (!await ensureDeviceRole("DISPLAY", display)) return; layout("調理状況", "受付番号で現在の状況をご確認ください。", `<div class="display-event">${eventPanel()}</div><div id="display-sync-status" class="stale-data-warning" role="status" hidden></div><div class="public-board"><section class="board-column cooking"><header><span aria-hidden="true">●</span><div><h2>ただいま調理中</h2><p>もうしばらくお待ちください</p></div><strong id="cooking-count">0</strong></header><div id="cooking-numbers" class="number-board"><div class="board-empty">準備中</div></div></section><section class="board-column ready"><header><span aria-hidden="true">●</span><div><h2>お渡しできます</h2><p>受け渡し口までお越しください</p></div><strong id="display-ready-count">0</strong></header><div id="display-numbers" class="number-board"><div class="board-empty">準備中</div></div></section></div>${deviceBadge()}`, { screen: "display", context: "お客様向け表示", eyebrow: "ORDER STATUS" }); bindDeviceChange(); await loadCurrentEvent(); startCurrentEventSync(); subscribeRealtime(); await loadDisplay(); state.refreshTimer = window.setInterval(() => { if (document.visibilityState !== "hidden") void loadDisplay(); }, FALLBACK_REFRESH_MS); }
async function loadDisplay() { const cookingTarget = document.querySelector("#cooking-numbers"); const readyTarget = document.querySelector("#display-numbers"); const syncStatus = document.querySelector("#display-sync-status"); if (!state.eventId) { document.querySelector("#cooking-count").textContent = "0"; document.querySelector("#display-ready-count").textContent = "0"; if (cookingTarget) cookingTarget.innerHTML = `<div class="board-empty">営業開始前です</div>`; if (readyTarget) readyTarget.innerHTML = `<div class="board-empty">営業開始前です</div>`; return; } try { const [cookingResult, readyResult] = await Promise.all([api(`/api/display/cooking?eventId=${encodeURIComponent(state.eventId)}`), api(`/api/display/ready?eventId=${encodeURIComponent(state.eventId)}`)]); const cookingOrders = cookingResult.orders || []; const readyOrders = readyResult.orders || []; const renderNumbers = (orders) => orders.map((order) => { const number = String(order.ticket_number); return `<div class="call-number ${number.length > 8 ? "long-number" : ""}">${escapeHtml(number)}</div>`; }).join(""); document.querySelector("#cooking-count").textContent = String(cookingOrders.length); document.querySelector("#display-ready-count").textContent = String(readyOrders.length); if (cookingTarget) cookingTarget.innerHTML = renderNumbers(cookingOrders) || `<div class="board-empty">現在、調理中の注文はありません</div>`; if (readyTarget) readyTarget.innerHTML = renderNumbers(readyOrders) || `<div class="board-empty">お渡しできる注文はまだありません</div>`; if (syncStatus) { syncStatus.hidden = true; syncStatus.replaceChildren(); } } catch { if (syncStatus) { syncStatus.hidden = false; syncStatus.innerHTML = `<strong>通信を再接続しています</strong><span>表示中の番号は通信断前の状態です。</span>`; } } }

function admin() { layout("管理", "メニューと受付番号をあらかじめ設定します。", `<div class="panel form-grid"><label>管理者トークン<input id="admin-token" type="password" /></label><button class="primary" id="load-settings">設定を読み込む</button><div id="settings-form"></div></div>`); document.querySelector("#load-settings").onclick = loadSettings; }
async function loadSettings() { const token = document.querySelector("#admin-token").value; try { const result = await api("/api/admin/order-number-settings", { headers: { Authorization: `Bearer ${token}` } }); const s = result.settings; localStorage.setItem("order-system:number-settings", JSON.stringify({ offlinePrefix: s.offline_prefix, offlineStartNumber: s.offline_start_number })); document.querySelector("#settings-form").innerHTML = `<form class="form-grid" id="settings"><label>オンライン開始<input name="onlineStartNumber" type="number" value="${s.online_start_number}" /></label><label>オンライン終了<input name="onlineEndNumber" type="number" value="${s.online_end_number}" /></label><label>オフライン接頭辞<input name="offlinePrefix" value="${s.offline_prefix}" /></label><label>オフライン開始<input name="offlineStartNumber" type="number" value="${s.offline_start_number}" /></label><button class="primary">番号設定を保存</button></form>`; document.querySelector("#settings").onsubmit = async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)); const payload = { onlineStartNumber: Number(data.onlineStartNumber), onlineEndNumber: Number(data.onlineEndNumber), offlinePrefix: data.offlinePrefix, offlineStartNumber: Number(data.offlineStartNumber) }; await api("/api/admin/order-number-settings", { method: "PATCH", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) }); localStorage.setItem("order-system:number-settings", JSON.stringify({ offlinePrefix: payload.offlinePrefix, offlineStartNumber: payload.offlineStartNumber })); alert("保存しました"); }; } catch (error) { document.querySelector("#settings-form").innerHTML = `<div class="error">${error.message}</div>`; } }

function adminPanel() {
  const locked = `<div class="locked-state"><span aria-hidden="true">鍵</span><strong>管理者ログインが必要です</strong><small>左側のログイン欄から認証してください</small></div>`;
  layout("管理", "営業状況の確認と、運用に必要な設定を行います。", `<div class="admin-shell"><aside class="admin-sidebar">
    <section class="admin-login-card panel"><div class="admin-login-heading"><div><span class="step-label">ADMIN</span><h2>管理者ログイン</h2></div><span id="admin-session-badge" class="session-badge">未ログイン</span></div><div id="admin-login-fields" class="form-grid"><label>ログイン名<input id="admin-login-name" autocomplete="username" /></label><label>パスワード<input id="admin-password" type="password" autocomplete="current-password" /><span class="muted">初回作成時は12文字以上にしてください。</span></label><label id="admin-setup-token-field" hidden>初回セットアップトークン<input id="admin-setup-token" type="password" autocomplete="off" /><span class="muted">Cloudflare Secretに設定した値を入力してください。</span></label><button class="primary" id="admin-login">ログイン</button><button class="text-button" id="admin-setup" hidden>初回管理者を作成</button><button class="text-button" id="admin-recovery">ログイン情報を忘れた場合</button><form id="admin-recovery-form" class="form-grid" hidden><div class="warning-message">Cloudflare復旧トークンでログインIDとパスワードを再設定します。すべての管理者ウィンドウはログアウトされます。注文・営業日・端末などのデータは変更しません。</div><label>Cloudflare復旧トークン<input name="recoveryToken" type="password" autocomplete="off" required /></label><label>新しいログイン名<input name="loginName" autocomplete="username" required /></label><label>新しいパスワード<input name="password" type="password" autocomplete="new-password" minlength="12" required /></label><button class="danger">ログイン情報を強制リセット</button></form></div><button class="secondary-action admin-logout" id="admin-logout" hidden>ログアウト</button><div id="admin-message"></div></section>
    <nav class="admin-nav" aria-label="管理メニュー"><button data-admin-target="order-management" disabled><span>概要</span><small>当日の状況</small></button><button data-admin-target="event-management" disabled><span>営業日</span><small>開始・終了</small></button><button data-admin-target="menu-management" disabled><span>メニュー</span><small>商品・味付け</small></button><button data-admin-target="reception-mode-management" disabled><span>受付画面</span><small>入力方式</small></button><button data-admin-target="number-management" disabled><span>受付番号</span><small>番号範囲</small></button><button data-admin-target="device-management" disabled><span>端末</span><small>役割とID</small></button><button data-admin-target="session-management" disabled><span>セッション</span><small>認証期間</small></button><button class="danger-nav" data-admin-target="danger-zone" disabled><span>Danger Zone</span><small>テストデータを消去</small></button></nav>
    <div class="launch-links"><small>各端末を直接開く</small><div><a href="/reception" data-route="reception">受付</a><a href="/kitchen" data-route="kitchen">調理</a><a href="/delivery" data-route="delivery">受け渡し</a><a href="/display" data-route="display">表示</a></div></div>
  </aside><div class="admin-content"><section id="order-management" class="admin-section panel stack active"><div class="section-heading"><div><span class="step-label">OVERVIEW</span><h2>当日の状況</h2></div></div><div id="order-summary">${locked}</div><dialog id="cancel-order-modal"></dialog><dialog id="order-audit-modal"></dialog></section><section id="event-management" class="admin-section panel stack"><div class="section-heading"><div><span class="step-label">BUSINESS DAY</span><h2>営業日</h2></div></div><div id="event-list">${locked}</div></section><section id="menu-management" class="admin-section panel stack"><div class="section-heading"><div><span class="step-label">MENU</span><h2>メニュー</h2></div></div><div id="menu-list">${locked}</div><dialog id="menu-admin-modal"></dialog></section><section id="reception-mode-management" class="admin-section panel stack"><div class="section-heading"><div><span class="step-label">RECEPTION</span><h2>受付画面</h2></div></div><div id="reception-mode-settings">${locked}</div></section><section id="number-management" class="admin-section panel stack"><div class="section-heading"><div><span class="step-label">ORDER NUMBER</span><h2>受付番号設定</h2></div></div><div id="settings-form">${locked}</div></section><section id="device-management" class="admin-section panel stack"><div class="section-heading"><div><span class="step-label">DEVICES</span><h2>端末設定</h2></div></div><div id="device-list">${locked}</div></section><section id="session-management" class="admin-section panel stack"><div class="section-heading"><div><span class="step-label">SECURITY</span><h2>セッション設定</h2></div></div><div id="session-settings">${locked}</div></section><section id="danger-zone" class="admin-section panel stack danger-zone"><div class="section-heading"><div><span class="step-label">DANGER ZONE</span><h2>テストデータの完全削除</h2></div></div><div id="danger-zone-content">${locked}</div></section></div></div>`, { screen: "admin", context: "管理画面", eyebrow: "ADMINISTRATION" });
  document.querySelectorAll("[data-admin-target]").forEach((button) => { button.onclick = () => activateAdminSection(button.dataset.adminTarget); });
  document.querySelector("#admin-login").onclick = async () => { const message = document.querySelector("#admin-message"); try { const result = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ loginName: document.querySelector("#admin-login-name").value, password: document.querySelector("#admin-password").value }) }); state.adminToken = result.token; sessionStorage.setItem("order-system:admin-token", state.adminToken); message.innerHTML = `<div class="success-message">ログインしました</div>`; updateAdminSessionUi(true); await loadAdminData(); } catch (error) { message.innerHTML = `<div class="error">${error.message}</div>`; } };
  document.querySelector("#admin-setup").onclick = async () => {
    const tokenField = document.querySelector("#admin-setup-token-field");
    const setupButton = document.querySelector("#admin-setup");
    if (tokenField.hidden) {
      tokenField.hidden = false;
      setupButton.textContent = "セットアップを実行";
      document.querySelector("#admin-setup-token").focus();
      return;
    }
    const message = document.querySelector("#admin-message");
    try {
      await api("/api/auth/setup", { method: "POST", body: JSON.stringify({ loginName: document.querySelector("#admin-login-name").value, password: document.querySelector("#admin-password").value, setupToken: document.querySelector("#admin-setup-token").value }) });
      message.innerHTML = `<div class="success-message">管理者を作成しました。ログインしてください。</div>`;
      tokenField.hidden = true;
      document.querySelector("#admin-setup-token").value = "";
      setupButton.textContent = "初回管理者を作成";
      setupButton.hidden = true;
    } catch (error) { message.innerHTML = `<div class="error">${error.message}</div>`; }
  };
  document.querySelector("#admin-recovery").onclick = () => {
    const form = document.querySelector("#admin-recovery-form");
    form.hidden = !form.hidden;
    if (!form.hidden) form.querySelector("input[name=recoveryToken]").focus();
  };
  document.querySelector("#admin-recovery-form").onsubmit = async (event) => {
    event.preventDefault();
    const message = document.querySelector("#admin-message");
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    const submit = form.querySelector("button");
    submit.disabled = true;
    try {
      await api("/api/auth/recover", { method: "POST", body: JSON.stringify(data) });
      clearTimer();
      state.adminToken = "";
      sessionStorage.removeItem("order-system:admin-token");
      form.reset();
      form.hidden = true;
      message.innerHTML = `<div class="success-message">ログイン情報をリセットしました。新しい情報でログインしてください。</div>`;
    } catch (error) {
      message.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    } finally {
      submit.disabled = false;
    }
  };
  document.querySelector("#admin-logout").onclick = async () => { try { await api("/api/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${state.adminToken}` } }); } finally { clearTimer(); state.adminToken = ""; sessionStorage.removeItem("order-system:admin-token"); adminPanel(); } };
  api("/api/auth/setup-status").then(({ available }) => { document.querySelector("#admin-setup").hidden = !available; }).catch(() => { document.querySelector("#admin-setup").hidden = true; });
  if (state.adminToken) { updateAdminSessionUi(true); loadAdminData(); }
}

function activateAdminSection(sectionId) {
  document.querySelectorAll(".admin-section").forEach((section) => section.classList.toggle("active", section.id === sectionId));
  document.querySelectorAll("[data-admin-target]").forEach((button) => button.classList.toggle("active", button.dataset.adminTarget === sectionId));
  document.querySelector(`#${CSS.escape(sectionId)}`)?.scrollIntoView({ block: "start" });
}

function updateAdminSessionUi(loggedIn) {
  document.querySelector("#admin-session-badge").textContent = loggedIn ? "ログイン中" : "未ログイン";
  document.querySelector("#admin-session-badge").classList.toggle("online", loggedIn);
  document.querySelector("#admin-login-fields").hidden = loggedIn;
  document.querySelector("#admin-logout").hidden = !loggedIn;
  document.querySelectorAll("[data-admin-target]").forEach((button) => { button.disabled = !loggedIn; });
  if (loggedIn) activateAdminSection("order-management");
}

async function loadAdminData() {
  await loadCurrentEvent();
  await Promise.all([loadEvents(state.adminToken), loadSettingsWithToken(state.adminToken), loadMenuAdmin(state.adminToken), loadReceptionSettings(state.adminToken), loadSessionSettings(state.adminToken), loadDevices(state.adminToken), loadDangerZone(state.adminToken), loadAdminStatus(state.adminToken)]);
  if (state.refreshTimer) window.clearInterval(state.refreshTimer);
  state.refreshTimer = window.setInterval(() => {
    if (document.visibilityState !== "hidden" && currentRoute() === "admin" && state.adminToken && state.socket?.readyState !== WebSocket.OPEN) void loadAdminSummary(state.adminToken);
  }, FALLBACK_REFRESH_MS);
  startCurrentEventSync();
  subscribeRealtime();
}

async function loadReceptionSettings(token) {
  const target = document.querySelector("#reception-mode-settings");
  try {
    const result = await api("/api/admin/settings/reception", { headers: { Authorization: `Bearer ${token}` } });
    target.innerHTML = `<form class="form-grid" id="reception-mode-form"><label>受付方法<select name="mode"><option value="DIRECT" ${result.mode === "DIRECT" ? "selected" : ""}>直接メニュー方式（メニューが少ない場合）</option><option value="CART" ${result.mode === "CART" ? "selected" : ""}>商品を追加する方式（メニューが多い場合）</option></select></label><div class="muted">どちらの方式でも、商品を押した後に味付け・サブ項目ごとの個数を入力できます。</div><button class="primary">受付方法を保存</button></form>`;
    document.querySelector("#reception-mode-form").onsubmit = async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)); await api("/api/admin/settings/reception", { method: "PATCH", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ mode: data.mode }) }); await loadReceptionSettings(token); };
  } catch (error) { target.innerHTML = `<div class="error">受付方法を読み込めません：${error.message}</div>`; }
}

async function loadSessionSettings(token) {
  try {
    const result = await api("/api/admin/settings/session", { headers: { Authorization: `Bearer ${token}` } });
    const s = result.settings;
    document.querySelector("#session-settings").innerHTML = `<form class="form-grid" id="session-form"><label>セッション期間（分）<input name="sessionDurationMinutes" type="number" min="1" value="${s.session_duration_minutes}" /></label><label>再認証猶予（分）<input name="reauthGraceMinutes" type="number" min="0" value="${s.reauth_grace_minutes}" /></label><button class="primary">セッション設定を保存</button></form>`;
    document.querySelector("#session-form").onsubmit = async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)); await api("/api/admin/settings/session", { method: "PATCH", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ sessionDurationMinutes: Number(data.sessionDurationMinutes), reauthGraceMinutes: Number(data.reauthGraceMinutes) }) }); alert("保存しました"); };
  } catch (error) { document.querySelector("#session-settings").innerHTML = `<div class="error">セッション設定を読み込めません：${error.message}</div>`; }
}

async function loadDevices(token) {
  const target = document.querySelector("#device-list");
  try {
    const result = await api("/api/admin/devices", { headers: { Authorization: `Bearer ${token}` } });
    target.innerHTML = `<form id="new-device" class="form-grid"><label>端末ID<input name="id" placeholder="KITCHEN-01" required /></label><label>表示名<input name="displayName" placeholder="調理端末01" required /></label><label>役割<select name="role"><option value="RECEPTION">受付</option><option value="KITCHEN">調理</option><option value="DELIVERY">受け渡し</option><option value="DISPLAY">表示</option><option value="ADMIN">管理</option></select></label><button class="primary">端末を登録してキーを発行</button></form><div id="device-key-message"></div><hr />` + (result.devices?.length ? `<div class="device-admin-list">${result.devices.map((device) => `<div class="panel device-admin-row"><div><strong>${escapeHtml(device.display_name)}</strong><div>${escapeHtml(device.id)} / ${escapeHtml(device.role)} / ${device.active ? "有効" : "無効"}${device.role === "KITCHEN" ? ` / <span class="device-presence ${device.kitchen_away ? "away" : "active"}">${device.kitchen_away ? "離席中" : "稼働中"}</span>` : ""}</div><small>${device.key_configured ? "キー発行済み" : "キー未発行"} / 最終接続：${escapeHtml(formatOrderTime(device.last_seen_at))}</small></div><div class="device-admin-actions"><button type="button" class="secondary-action" data-rotate-device="${escapeHtml(device.id)}">${device.key_configured ? "端末キーを再発行" : "端末キーを発行"}</button><button type="button" class="${device.active ? "danger" : "secondary-action"}" data-toggle-device="${escapeHtml(device.id)}" data-active="${device.active ? "1" : "0"}">${device.active ? "無効にする" : "有効にする"}</button><button type="button" class="danger" data-delete-device="${escapeHtml(device.id)}">削除</button></div></div>`).join("")}</div>` : `<div class="empty">端末がありません</div>`);
    const showDeviceKey = (deviceId, deviceKey) => { document.querySelector("#device-key-message").innerHTML = `<div class="device-key-result"><strong>${escapeHtml(deviceId)} の端末キー</strong><code>${escapeHtml(deviceKey)}</code><small>このキーは今だけ表示されます。対象端末へ安全に渡してください。</small></div>`; };
    document.querySelector("#new-device").onsubmit = async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)); const created = await api("/api/admin/devices", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ id: data.id, displayName: data.displayName, role: data.role }) }); await loadDevices(token); showDeviceKey(created.device.id, created.deviceKey); };
    target.querySelectorAll("[data-rotate-device]").forEach((button) => { button.onclick = async () => { if (!window.confirm(`${button.dataset.rotateDevice} の現在の端末キーを無効にして再発行しますか？`)) return; const updated = await api(`/api/admin/devices/${encodeURIComponent(button.dataset.rotateDevice)}`, { method: "PATCH", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ rotateKey: true }) }); showDeviceKey(button.dataset.rotateDevice, updated.deviceKey); }; });
    target.querySelectorAll("[data-toggle-device]").forEach((button) => { button.onclick = async () => { const active = button.dataset.active === "1"; if (active && !window.confirm(`${button.dataset.toggleDevice} を無効にしますか？この端末は直ちに操作できなくなります。`)) return; await api(`/api/admin/devices/${encodeURIComponent(button.dataset.toggleDevice)}`, { method: "PATCH", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ active: !active }) }); await loadDevices(token); }; });
    target.querySelectorAll("[data-delete-device]").forEach((button) => { button.onclick = async () => { if (!window.confirm(`${button.dataset.deleteDevice} を削除しますか？過去の担当記録は残ります。`)) return; try { await api(`/api/admin/devices/${encodeURIComponent(button.dataset.deleteDevice)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }); await loadDevices(token); } catch (error) { window.alert(error.message); } }; });
  } catch (error) { target.innerHTML = `<div class="error">端末設定を読み込めません：${error.message}</div>`; }
}

async function loadAdminStatus(token, { refreshProducts = true } = {}) {
  const target = document.querySelector("#order-summary");
  try {
    const event = state.currentEvent || (await api("/api/current-business-day")).event;
    if (!event) { target.innerHTML = `<div class="empty"><strong>営業日はまだ開始されていません</strong><small>「営業日」タブで営業日を追加し、「開始」を押すと当日の注文状況を表示します。</small></div>`; return; }
    const [summaryResult, ordersResult] = await Promise.all([
      api(`/api/admin/summary?eventId=${encodeURIComponent(event.id)}${refreshProducts ? "" : "&includeProducts=false"}`, { headers: { Authorization: `Bearer ${token}` } }),
      api(`/api/admin/orders?eventId=${encodeURIComponent(event.id)}`, { headers: { Authorization: `Bearer ${token}` } }),
    ]);
    if (summaryResult.itemTotal !== undefined) state.adminItemTotal = summaryResult.itemTotal;
    if (summaryResult.productCounts !== undefined) state.adminProductCounts = summaryResult.productCounts;
    const itemTotal = state.adminItemTotal ?? 0;
    const productCounts = state.adminProductCounts ?? [];
    summaryResult.itemTotal = itemTotal;
    summaryResult.productCounts = productCounts;
    const summary = summaryResult.summary;
    const statusLabels = { WAITING: "調理待ち", COOKING: "調理中", READY: "受け渡し待ち", COMPLETED: "提供済み", CANCELLED: "キャンセル" };
    const orderRows = [...(ordersResult.orders || [])].reverse().map((order) => {
      const actions = [`<button type="button" class="secondary-action" data-order-history="${escapeHtml(order.id)}" data-ticket-number="${escapeHtml(order.ticket_number)}">操作履歴を見る</button>`];
      if (order.status === "COOKING") actions.push(`<button type="button" class="secondary-action" data-requeue-order="${escapeHtml(order.id)}" data-ticket-number="${escapeHtml(order.ticket_number)}">調理待ちへ戻す</button>`);
      if (["WAITING", "COOKING", "READY", "COMPLETED"].includes(order.status)) actions.push(`<button type="button" class="danger" data-cancel-order="${escapeHtml(order.id)}" data-ticket-number="${escapeHtml(order.ticket_number)}" data-order-status="${escapeHtml(order.status)}">${order.status === "COOKING" ? "強制取り消し" : "注文を取り消す"}</button>`);
      return `<article class="order-history-row"><header><strong>${escapeHtml(order.ticket_number)}</strong><span class="status-tag ${escapeHtml(order.status.toLowerCase())}">${escapeHtml(statusLabels[order.status] || order.status)}</span><span class="assigned-device">担当：${escapeHtml(order.assigned_device_id || "未割当")}</span></header>${renderOrderItems(order.items)}<dl class="order-timeline"><div><dt>受付</dt><dd>${escapeHtml(formatOrderTime(order.accepted_at))}</dd></div><div><dt>調理開始</dt><dd>${escapeHtml(formatOrderTime(order.cooking_started_at))}</dd></div><div><dt>調理完了</dt><dd>${escapeHtml(formatOrderTime(order.ready_at))}</dd></div><div><dt>提供完了</dt><dd>${escapeHtml(formatOrderTime(order.completed_at))}</dd></div></dl>${actions.length ? `<div class="admin-order-actions">${actions.join("")}</div>` : ""}</article>`;
    }).join("");
    const refreshedAt = new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date());
    target.innerHTML = `<div class="summary-grid"><div class="summary-card items" data-summary-items><span>注文商品数</span><strong>${summaryResult.itemTotal}</strong><small>取消済みを除く商品点数</small></div><div class="summary-card waiting" data-summary-status="WAITING"><span>調理待ち</span><strong>${summary.WAITING}</strong><small>WAITING</small></div><div class="summary-card cooking" data-summary-status="COOKING"><span>調理中</span><strong>${summary.COOKING}</strong><small>COOKING</small></div><div class="summary-card ready" data-summary-status="READY"><span>受け渡し待ち</span><strong>${summary.READY}</strong><small>READY</small></div><div class="summary-card completed" data-summary-status="COMPLETED"><span>提供済み</span><strong>${summary.COMPLETED}</strong><small>COMPLETED</small></div><div class="summary-card cancelled" data-summary-status="CANCELLED"><span>取消済み</span><strong>${summary.CANCELLED}</strong><small>CANCELLED</small></div></div><section class="admin-product-summary"><div class="admin-list-heading"><div><h3>商品別集計</h3><small>味付けなどのオプションは商品にまとめて集計</small></div><button type="button" class="secondary-action" id="download-product-summary-csv">商品別集計CSV</button></div><div id="admin-product-counts">${renderProductCountTable(summaryResult.productCounts, { showManagementColumns: true })}</div></section><div class="admin-list-heading"><div><h3>すべての注文</h3><small>最終更新：${escapeHtml(refreshedAt)}</small></div><div class="button-row"><button type="button" class="secondary-action" id="refresh-admin-orders">最新状態に更新</button><button class="secondary-action" id="download-csv">注文一覧CSV</button></div></div><div class="order-history">${orderRows || `<div class="empty">注文はありません</div>`}</div>`;
    document.querySelector("#refresh-admin-orders").onclick = async (event) => { const button = event.currentTarget; button.disabled = true; await loadAdminStatus(token); if (button.isConnected) button.disabled = false; };
    document.querySelector("#download-csv").onclick = async () => { const response = await fetch(`/api/admin/export.csv?eventId=${encodeURIComponent(event.id)}`, { headers: { Authorization: `Bearer ${token}` } }); const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `orders-${event.business_date}.csv`; link.click(); URL.revokeObjectURL(url); };
    document.querySelector("#download-product-summary-csv").onclick = async () => { const response = await fetch(`/api/admin/product-summary.csv?eventId=${encodeURIComponent(event.id)}`, { headers: { Authorization: `Bearer ${token}` } }); const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `product-summary-${event.business_date}.csv`; link.click(); URL.revokeObjectURL(url); };
    target.querySelectorAll("[data-requeue-order]").forEach((button) => { button.onclick = async () => { if (!window.confirm(`受付番号 ${button.dataset.ticketNumber} を調理待ちへ戻しますか？故障した調理端末では以後操作しないでください。`)) return; button.disabled = true; try { const operationId = createClientId(); const result = await api(`/api/admin/orders/${encodeURIComponent(button.dataset.requeueOrder)}/requeue`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ operationId }) }); await loadAdminStatus(token); offerUndo({ operationId: result.undoOperationId || operationId, expiresAt: result.undoExpiresAt, label: `受付番号 ${button.dataset.ticketNumber} の待機戻しを元に戻す`, adminToken: token, onUndone: () => loadAdminStatus(token) }); } catch (error) { button.disabled = false; window.alert(error.message); } }; });
    target.querySelectorAll("[data-cancel-order]").forEach((button) => { button.onclick = () => openCancelOrderDialog(button.dataset.cancelOrder, button.dataset.ticketNumber, button.dataset.orderStatus, token); });
    target.querySelectorAll("[data-order-history]").forEach((button) => { button.onclick = () => openOrderAuditDialog(button.dataset.orderHistory, button.dataset.ticketNumber, token); });
  } catch (error) {
    if (target.querySelector(".order-history")) {
      target.querySelector("#admin-status-error")?.remove();
      target.insertAdjacentHTML("afterbegin", `<div id="admin-status-error" class="stale-data-warning"><strong>最新状態を取得できません</strong><span>${escapeHtml(error.message)} 表示中の内容は直前の状態です。</span></div>`);
    } else if (!state.currentEvent) {
      target.innerHTML = `<div class="empty"><strong>営業日はまだ開始されていません</strong><small>「営業日」タブで営業日を追加し、「開始」を押すと当日の注文状況を表示します。</small></div>`;
    } else {
      target.innerHTML = `<div class="error">状況を読み込めません：${escapeHtml(error.message)}</div>`;
    }
  }
}

async function loadAdminSummary(token) {
  const target = document.querySelector("#order-summary");
  const event = state.currentEvent;
  if (!target || !event || !target.querySelector("[data-summary-status]")) return;
  try {
    const result = await api(`/api/admin/summary?eventId=${encodeURIComponent(event.id)}`, { headers: { Authorization: `Bearer ${token}` } });
    for (const [status, count] of Object.entries(result.summary || {})) {
      const value = target.querySelector(`[data-summary-status="${CSS.escape(status)}"] strong`);
      if (value) value.textContent = String(count);
    }
    const itemTotal = target.querySelector("[data-summary-items] strong");
    if (itemTotal) itemTotal.textContent = String(result.itemTotal ?? 0);
    const productCounts = target.querySelector("#admin-product-counts");
    if (productCounts) productCounts.innerHTML = renderProductCountTable(result.productCounts, { showManagementColumns: true });
    target.querySelector("#admin-status-error")?.remove();
  } catch (error) {
    target.querySelector("#admin-status-error")?.remove();
    target.insertAdjacentHTML("afterbegin", `<div id="admin-status-error" class="stale-data-warning"><strong>集計を更新できません</strong><span>${escapeHtml(error.message)} 注文一覧は直前の状態です。</span></div>`);
  }
}

async function openOrderAuditDialog(orderId, ticketNumber, token) {
  const modal = document.querySelector("#order-audit-modal");
  if (!modal) return;
  modal.innerHTML = `<div class="modal-card"><div class="modal-header"><div><span class="step-label">AUDIT TRAIL</span><h2>受付番号 ${escapeHtml(ticketNumber)} の操作履歴</h2></div><button type="button" class="modal-close" aria-label="閉じる">×</button></div><div id="order-audit-content" aria-live="polite"><div class="loading-state">履歴を読み込んでいます</div></div></div>`;
  modal.querySelector(".modal-close").onclick = () => modal.close();
  modal.showModal();
  const target = modal.querySelector("#order-audit-content");
  try {
    const result = await api(`/api/admin/orders/${encodeURIComponent(orderId)}/history`, { headers: { Authorization: `Bearer ${token}` } });
    const statusLabels = { WAITING: "調理待ち", COOKING: "調理中", READY: "受け渡し待ち", COMPLETED: "提供済み", CANCELLED: "キャンセル" };
    const rows = (result.history || []).map((entry) => {
      const from = entry.from_status ? statusLabels[entry.from_status] || entry.from_status : "受付前";
      const to = statusLabels[entry.to_status] || entry.to_status;
      const reason = typeof entry.metadata?.note === "string"
        ? entry.metadata.note
        : entry.metadata?.reason === "MANUAL_REQUEUE" ? "管理者による調理待ちへの復旧"
            : entry.metadata?.reason === "DELIVERY_REWORK" ? "受け渡し端末から前担当へ再調理を依頼"
              : entry.metadata?.reason === "DELIVERY_REWORK_DISPLACED" ? "再調理を優先するため調理待ちへ移動"
              : entry.metadata?.reason === "ADMIN_FORCE_CANCEL" ? "管理者による調理中注文の強制取消"
                : entry.metadata?.reason === "UNDO_CREATE" ? "受付確定を10秒以内に取り消し"
                  : entry.metadata?.reason === "UNDO_DISPLACED" ? "直前操作の復元に伴い調理待ちへ移動"
                    : entry.metadata?.reason === "UNDO_DISPLACEMENT" ? "直前操作の復元に伴い担当へ戻す"
                      : entry.metadata?.reason === "UNDO" ? "直前操作を10秒以内に取り消し" : "";
      return `<li class="audit-entry"><div class="audit-transition"><span>${escapeHtml(from)}</span><strong>→</strong><span>${escapeHtml(to)}</span></div><dl><div><dt>操作時刻</dt><dd>${escapeHtml(formatOrderTime(entry.created_at))}</dd></div><div><dt>操作端末</dt><dd>${escapeHtml(entry.device_id || "システム")}</dd></div><div><dt>操作ID</dt><dd><code>${escapeHtml(entry.operation_id)}</code></dd></div>${reason ? `<div><dt>理由</dt><dd>${escapeHtml(reason)}</dd></div>` : ""}</dl></li>`;
    }).join("");
    target.innerHTML = `<div class="audit-current-status">現在：<span class="status-tag ${escapeHtml(result.order.status.toLowerCase())}">${escapeHtml(statusLabels[result.order.status] || result.order.status)}</span></div><ol class="audit-list">${rows || `<li class="empty">履歴はありません</li>`}</ol>`;
  } catch (error) {
    target.innerHTML = `<div class="error">履歴を読み込めません：${escapeHtml(error.message)}</div>`;
  }
}

function openCancelOrderDialog(orderId, ticketNumber, orderStatus, token) {
  const modal = document.querySelector("#cancel-order-modal");
  if (!modal) return;
  const forceCooking = orderStatus === "COOKING";
  modal.innerHTML = `<form id="cancel-order-form" class="modal-card"><div class="modal-header"><div><span class="step-label">${forceCooking ? "FORCE CANCEL — STEP 1/2" : "CANCEL ORDER"}</span><h2>受付番号 ${escapeHtml(ticketNumber)} を取り消す</h2></div><button type="button" class="modal-close" aria-label="閉じる">×</button></div><div class="warning-message">${forceCooking ? "この注文は調理中です。強制取消すると調理端末から直ちに消えます。操作後10秒以内なら元に戻せます。" : "調理待ち・受け渡し待ち・提供済みの注文を取り消せます。操作後10秒以内なら元に戻せます。"}</div><label>取消理由<textarea name="reason" rows="3" maxlength="200" required placeholder="例：受付内容の誤り"></textarea><small class="muted">監査履歴に管理者IDと一緒に保存されます（200文字以内）。</small></label><div id="cancel-order-message" aria-live="assertive"></div><div class="button-row"><button type="button" class="secondary-action" id="cancel-order-back">戻る</button><button type="submit" class="danger">${forceCooking ? "確認画面へ" : "この注文を取り消す"}</button></div></form>`;
  modal.querySelector(".modal-close").onclick = () => modal.close();
  modal.querySelector("#cancel-order-back").onclick = () => modal.close();
  modal.querySelector("#cancel-order-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('button[type="submit"]');
    const message = form.querySelector("#cancel-order-message");
    const reason = String(new FormData(form).get("reason") || "").trim();
    if (!reason) { message.innerHTML = `<div class="error">取消理由を入力してください。</div>`; return; }
    if (forceCooking) {
      modal.innerHTML = `<form id="force-cancel-confirm-form" class="modal-card"><div class="modal-header"><div><span class="step-label">FORCE CANCEL — STEP 2/2</span><h2>調理中注文を本当に取り消しますか？</h2></div><button type="button" class="modal-close" aria-label="閉じる">×</button></div><div class="warning-message"><strong>受付番号 ${escapeHtml(ticketNumber)}</strong><br />前の画面で入力した理由：${escapeHtml(reason)}</div><label>確認のため受付番号 <strong>${escapeHtml(ticketNumber)}</strong> を入力<input name="ticketNumberConfirmation" inputmode="text" autocomplete="off" required /></label><div id="cancel-order-message" aria-live="assertive"></div><div class="button-row"><button type="button" class="secondary-action" id="force-cancel-back">前の画面へ戻る</button><button type="submit" class="danger" disabled>調理中でも強制取り消し</button></div></form>`;
      const confirmForm = modal.querySelector("#force-cancel-confirm-form");
      const confirmInput = confirmForm.querySelector("input");
      const confirmSubmit = confirmForm.querySelector('button[type="submit"]');
      modal.querySelector(".modal-close").onclick = () => modal.close();
      modal.querySelector("#force-cancel-back").onclick = () => { modal.close(); openCancelOrderDialog(orderId, ticketNumber, orderStatus, token); };
      confirmInput.oninput = () => { confirmSubmit.disabled = confirmInput.value.trim() !== ticketNumber; };
      confirmForm.onsubmit = async (confirmEvent) => {
        confirmEvent.preventDefault();
        if (confirmInput.value.trim() !== ticketNumber) return;
        confirmSubmit.disabled = true;
        try {
          const operationId = createClientId();
          const result = await api(`/api/admin/orders/${encodeURIComponent(orderId)}/cancel`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ operationId, reason, forceCooking: true, confirmedTicketNumber: ticketNumber }) });
          modal.close();
          await loadAdminStatus(token);
          offerUndo({ operationId: result.undoOperationId || operationId, expiresAt: result.undoExpiresAt, label: `受付番号 ${ticketNumber} の強制取消を元に戻す`, adminToken: token, onUndone: () => loadAdminStatus(token) });
        } catch (error) {
          confirmSubmit.disabled = false;
          modal.querySelector("#cancel-order-message").innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
        }
      };
      confirmInput.focus();
      return;
    }
    submit.disabled = true;
    try {
      const operationId = createClientId();
      const result = await api(`/api/admin/orders/${encodeURIComponent(orderId)}/cancel`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ operationId, reason }) });
      modal.close();
      await loadAdminStatus(token);
      offerUndo({ operationId: result.undoOperationId || operationId, expiresAt: result.undoExpiresAt, label: `受付番号 ${ticketNumber} の取消を元に戻す`, adminToken: token, onUndone: () => loadAdminStatus(token) });
    } catch (error) {
      submit.disabled = false;
      message.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    }
  };
  modal.showModal();
  modal.querySelector("textarea").focus();
}

async function loadMenuAdmin(token) {
  const target = document.querySelector("#menu-list");
  try {
    const result = await api("/api/admin/menu", { headers: { Authorization: `Bearer ${token}` } });
    target.innerHTML = `<form id="new-menu-item" class="form-grid"><label>商品名<input name="name" placeholder="焼きそば" required /></label><label>説明<input name="description" placeholder="商品説明（任意）" /></label><button class="primary">商品を追加</button></form><div id="menu-message"></div><hr />` + (result.items?.length ? `<div class="stack menu-item-list">${result.items.map((item, index) => renderMenuItem(item, index, result.items.length)).join("")}</div>` : `<div class="empty">メニューがありません</div>`);
    const showMenuError = (error) => { const message = document.querySelector("#menu-message"); if (message) message.innerHTML = `<div class="error">${error.message}</div>`; };
    document.querySelector("#new-menu-item").onsubmit = async (event) => { event.preventDefault(); try { const data = Object.fromEntries(new FormData(event.target)); await api("/api/admin/menu/items", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: data.name, description: data.description }) }); await loadMenuAdmin(token); } catch (error) { showMenuError(error); } };
    target.querySelectorAll("[data-menu-detail]").forEach((button) => { button.onclick = () => { const item = result.items.find((candidate) => candidate.id === button.dataset.menuDetail); if (item) openMenuAdminDetail(item, token); }; });
    target.querySelectorAll("[data-move-item]").forEach((button) => { button.onclick = async (event) => { event.stopPropagation(); try { await reorderMenuItems(result.items, button.dataset.moveItem, Number(button.dataset.direction), token); } catch (error) { showMenuError(error); } }; });
    return result.items || [];
  } catch (error) { target.innerHTML = `<div class="error">メニューを読み込めません：${error.message}</div>`; return []; }
}

function renderMenuItem(item, index, total) {
  return `<div class="menu-item-row"><button type="button" class="menu-item-summary ${item.active ? "" : "inactive"}" data-menu-detail="${escapeHtml(item.id)}"><strong>${escapeHtml(item.name)}</strong><span class="summary-action">設定を開く</span></button><div class="reorder-actions"><button type="button" aria-label="${escapeHtml(item.name)}を上へ" data-move-item="${escapeHtml(item.id)}" data-direction="-1" ${index === 0 ? "disabled" : ""}>↑</button><button type="button" aria-label="${escapeHtml(item.name)}を下へ" data-move-item="${escapeHtml(item.id)}" data-direction="1" ${index === total - 1 ? "disabled" : ""}>↓</button></div></div>`;
}

async function reorderMenuItems(items, itemId, direction, token) {
  const ordered = [...items];
  const index = ordered.findIndex((item) => item.id === itemId);
  const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= ordered.length) return;
  [ordered[index], ordered[targetIndex]] = [ordered[targetIndex], ordered[index]];
  await Promise.all(ordered.map((item, order) => api(`/api/admin/menu/items/${item.id}`, { method: "PATCH", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ sortOrder: order }) })));
  await loadMenuAdmin(token);
}

function openMenuAdminDetail(item, token) {
  const modal = document.querySelector("#menu-admin-modal");
  if (!modal) return;
  const groups = (item.option_groups || []).map((group, groupIndex, allGroups) => `<section class="menu-admin-group ${group.active ? "" : "inactive"}"><div class="menu-admin-group-header"><div class="menu-admin-group-title"><strong>${escapeHtml(group.name)}</strong>${group.active ? `<label class="required-group-toggle"><input type="checkbox" data-required-group="${escapeHtml(group.id)}" ${group.required ? "checked" : ""} /><span>選択を必須にする</span></label>` : ""}</div><div class="reorder-actions"><button type="button" aria-label="${escapeHtml(group.name)}を上へ" data-move-group="${escapeHtml(group.id)}" data-direction="-1" ${groupIndex === 0 ? "disabled" : ""}>↑</button><button type="button" aria-label="${escapeHtml(group.name)}を下へ" data-move-group="${escapeHtml(group.id)}" data-direction="1" ${groupIndex === allGroups.length - 1 ? "disabled" : ""}>↓</button><button type="button" class="danger small-action" data-delete-group="${escapeHtml(group.id)}">${group.active ? "削除" : "削除済み"}</button></div></div><div class="menu-option-list">${(group.options || []).map((option, optionIndex, allOptions) => `<div class="menu-option-row ${option.active ? "" : "inactive"}"><span>${escapeHtml(option.name)}</span><div class="reorder-actions"><button type="button" aria-label="${escapeHtml(option.name)}を上へ" data-move-option="${escapeHtml(group.id)}:${escapeHtml(option.id)}" data-direction="-1" ${optionIndex === 0 ? "disabled" : ""}>↑</button><button type="button" aria-label="${escapeHtml(option.name)}を下へ" data-move-option="${escapeHtml(group.id)}:${escapeHtml(option.id)}" data-direction="1" ${optionIndex === allOptions.length - 1 ? "disabled" : ""}>↓</button><button type="button" class="danger small-action" data-delete-option="${escapeHtml(group.id)}:${escapeHtml(option.id)}">${option.active ? "削除" : "削除済み"}</button></div></div>`).join("") || `<div class="muted">味付けがありません</div>`}</div>${group.active ? `<form class="option-form menu-admin-form" data-group-id="${escapeHtml(group.id)}"><input name="name" placeholder="例：ソース味" required autocomplete="off" /><button>味付けを追加</button></form>` : ""}</section>`).join("");
  modal.innerHTML = `<div class="modal-card menu-admin-card"><div class="modal-header"><div><h2>${escapeHtml(item.name)}</h2>${item.description ? `<div class="muted">${escapeHtml(item.description)}</div>` : ""}</div><button type="button" class="modal-close" aria-label="閉じる">×</button></div><div id="menu-detail-message"></div><div class="menu-admin-actions">${item.active ? `<button type="button" class="danger" id="delete-menu">メニューを削除</button>` : `<div class="warning-message">このメニューは受付には表示されません。注文履歴に未使用の場合だけ完全に削除できます。</div><button type="button" class="danger" id="purge-menu">完全に削除</button>`}</div><div class="menu-admin-groups">${groups || `<div class="empty">味付け・サブ項目グループがありません</div>`}</div><form id="new-option-group" class="form-grid" ${item.active ? "" : "hidden"}><label>新しい味付け・サブ項目<input name="name" placeholder="例：味付け" required autocomplete="off" /></label><label>選択方法<select name="selectionType"><option value="SINGLE">1つ選択</option><option value="MULTIPLE">複数選択</option></select></label><label class="required-group-create"><input type="checkbox" name="required" /><span>選択を必須にする</span></label><button class="primary">グループを追加</button></form></div>`;
  modal.querySelectorAll(".modal-close").forEach((button) => { button.onclick = () => modal.close(); });
  const showDetailError = (error) => { const message = modal.querySelector("#menu-detail-message"); if (message) message.innerHTML = `<div class="error">${error.message}</div>`; };
  const deleteButton = modal.querySelector("#delete-menu");
  if (deleteButton) deleteButton.onclick = async () => { if (!window.confirm("このメニューを受付から削除しますか？注文履歴は残ります。")) return; try { await api(`/api/admin/menu/items/${item.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }); modal.close(); await loadMenuAdmin(token); } catch (error) { showDetailError(error); } };
  const purgeButton = modal.querySelector("#purge-menu");
  if (purgeButton) purgeButton.onclick = async () => { if (!window.confirm("このメニューを完全に削除しますか？元に戻せません。")) return; try { await api(`/api/admin/menu/items/${item.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }); modal.close(); await loadMenuAdmin(token); } catch (error) { showDetailError(error); } };
  modal.querySelector("#new-option-group").onsubmit = async (event) => { event.preventDefault(); try { const data = Object.fromEntries(new FormData(event.target)); await api(`/api/admin/menu/items/${item.id}/option-groups`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: data.name, selectionType: data.selectionType, required: data.required === "on" }) }); const items = await loadMenuAdmin(token); const updated = items.find((candidate) => candidate.id === item.id); if (updated) openMenuAdminDetail(updated, token); } catch (error) { showDetailError(error); } };
  modal.querySelectorAll("[data-required-group]").forEach((checkbox) => { checkbox.onchange = async () => { checkbox.disabled = true; try { await api(`/api/admin/menu/option-groups/${checkbox.dataset.requiredGroup}`, { method: "PATCH", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ required: checkbox.checked }) }); const items = await loadMenuAdmin(token); const updated = items.find((candidate) => candidate.id === item.id); if (updated) openMenuAdminDetail(updated, token); } catch (error) { checkbox.checked = !checkbox.checked; checkbox.disabled = false; showDetailError(error); } }; });
  modal.querySelectorAll(".option-form").forEach((form) => { form.onsubmit = async (event) => { event.preventDefault(); const input = form.querySelector("input[name=name]"); try { const data = Object.fromEntries(new FormData(form)); await api(`/api/admin/menu/option-groups/${form.dataset.groupId}/options`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: data.name }) }); const items = await loadMenuAdmin(token); const updated = items.find((candidate) => candidate.id === item.id); if (updated) { openMenuAdminDetail(updated, token); const nextInput = document.querySelector(`.option-form[data-group-id="${CSS.escape(form.dataset.groupId)}"] input[name=name]`); nextInput?.focus(); } } catch (error) { showDetailError(error); input?.focus(); } }; });
  modal.querySelectorAll("[data-delete-group]").forEach((button) => { button.onclick = async () => { if (!window.confirm("この味付けグループを削除しますか？")) return; try { await api(`/api/admin/menu/option-groups/${button.dataset.deleteGroup}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }); const items = await loadMenuAdmin(token); const updated = items.find((candidate) => candidate.id === item.id); if (updated) openMenuAdminDetail(updated, token); } catch (error) { showDetailError(error); } }; });
  modal.querySelectorAll("[data-delete-option]").forEach((button) => { button.onclick = async () => { const [groupId, optionId] = button.dataset.deleteOption.split(":"); if (!window.confirm("この味付けを削除しますか？")) return; try { await api(`/api/admin/menu/option-groups/${groupId}/options/${optionId}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }); const items = await loadMenuAdmin(token); const updated = items.find((candidate) => candidate.id === item.id); if (updated) openMenuAdminDetail(updated, token); } catch (error) { showDetailError(error); } }; });
  modal.querySelectorAll("[data-move-group]").forEach((button) => { button.onclick = async () => { try { const groupsToMove = item.option_groups || []; await reorderOptionGroups(groupsToMove, button.dataset.moveGroup, Number(button.dataset.direction), token); const items = await loadMenuAdmin(token); const updated = items.find((candidate) => candidate.id === item.id); if (updated) openMenuAdminDetail(updated, token); } catch (error) { showDetailError(error); } }; });
  modal.querySelectorAll("[data-move-option]").forEach((button) => { button.onclick = async () => { try { const [groupId, optionId] = button.dataset.moveOption.split(":"); const group = (item.option_groups || []).find((candidate) => candidate.id === groupId); if (!group) return; await reorderOptions(group.options || [], groupId, optionId, Number(button.dataset.direction), token); const items = await loadMenuAdmin(token); const updated = items.find((candidate) => candidate.id === item.id); if (updated) openMenuAdminDetail(updated, token); } catch (error) { showDetailError(error); } }; });
  if (!modal.open) modal.showModal();
}

async function reorderOptionGroups(groups, groupId, direction, token) {
  const ordered = [...groups]; const index = ordered.findIndex((group) => group.id === groupId); const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= ordered.length) return;
  [ordered[index], ordered[targetIndex]] = [ordered[targetIndex], ordered[index]];
  await Promise.all(ordered.map((group, order) => api(`/api/admin/menu/option-groups/${group.id}`, { method: "PATCH", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ sortOrder: order }) })));
}

async function reorderOptions(options, groupId, optionId, direction, token) {
  const ordered = [...options]; const index = ordered.findIndex((option) => option.id === optionId); const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= ordered.length) return;
  [ordered[index], ordered[targetIndex]] = [ordered[targetIndex], ordered[index]];
  await Promise.all(ordered.map((option, order) => api(`/api/admin/menu/option-groups/${groupId}/options/${option.id}`, { method: "PATCH", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ sortOrder: order }) })));
}

async function loadEvents(token) {
  const target = document.querySelector("#event-list");
  try {
    const result = await api("/api/admin/events", { headers: { Authorization: `Bearer ${token}` } });
    const statusLabels = { DRAFT: "準備中", OPEN: "営業中", CLOSED: "終了" };
    target.innerHTML = `<form id="new-event" class="event-create-form"><label>営業日名<input name="name" placeholder="文化祭 1日目" required /></label><label>日付<input name="businessDate" type="date" required /></label><button class="primary">営業日を追加</button></form><div class="event-list">${result.events?.length ? result.events.map((event) => `<article class="event-card"><div class="event-card-main"><span class="event-status ${escapeHtml(event.status.toLowerCase())}">${escapeHtml(statusLabels[event.status])}</span><div><strong>${escapeHtml(event.name)}</strong><small>${escapeHtml(event.business_date)}${event.order_count ? ` ・ 注文 ${escapeHtml(event.order_count)}件` : " ・ 注文なし"}</small></div></div><div class="event-card-actions"><button type="button" class="secondary-action" data-edit-event="${escapeHtml(event.id)}">編集</button>${event.status !== "OPEN" ? `<button type="button" class="primary" data-open="${escapeHtml(event.id)}">開始</button>` : `<button type="button" class="warning" data-close="${escapeHtml(event.id)}">終了</button>`}<button type="button" class="danger" data-delete-event="${escapeHtml(event.id)}" ${event.status === "OPEN" || event.order_count ? "disabled" : ""}>削除</button></div></article>`).join("") : `<div class="empty">営業日がありません</div>`}</div><dialog id="event-editor-modal"></dialog>`;
    document.querySelector("#new-event").onsubmit = async (formEvent) => { formEvent.preventDefault(); const data = Object.fromEntries(new FormData(formEvent.target)); await api("/api/admin/events", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: data.name, businessDate: data.businessDate }) }); await loadEvents(token); };
    target.querySelectorAll("[data-edit-event]").forEach((button) => { button.onclick = () => { const event = result.events.find((candidate) => candidate.id === button.dataset.editEvent); if (event) openEventEditor(event, token); }; });
    target.querySelectorAll("[data-open]").forEach((button) => { button.onclick = async () => { await api(`/api/admin/events/${button.dataset.open}`, { method: "PATCH", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ status: "OPEN" }) }); resetRealtimeSocket(); await loadAdminData(); }; });
    target.querySelectorAll("[data-close]").forEach((button) => { button.onclick = async () => { await api(`/api/admin/events/${button.dataset.close}`, { method: "PATCH", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ status: "CLOSED" }) }); resetRealtimeSocket(); await loadAdminData(); }; });
    target.querySelectorAll("[data-delete-event]").forEach((button) => { button.onclick = async () => { if (!window.confirm("注文のない営業日を完全に削除しますか？元に戻せません。")) return; try { await api(`/api/admin/events/${encodeURIComponent(button.dataset.deleteEvent)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }); await loadEvents(token); } catch (error) { window.alert(error.message); } }; });
  } catch (error) { target.innerHTML = `<div class="error">営業日を読み込めません：${error.message}</div>`; }
}

async function loadDangerZone(token) {
  const target = document.querySelector("#danger-zone-content");
  try {
    const result = await api("/api/admin/events", { headers: { Authorization: `Bearer ${token}` } });
    const statusLabels = { DRAFT: "準備中", OPEN: "営業中", CLOSED: "終了" };
    target.innerHTML = `<div class="danger-zone-notice"><strong>テスト用の営業日を完全に削除</strong><p>営業日・すべての注文・注文内容・操作履歴を削除します。元に戻せません。通常の運用では使用しないでください。</p></div>${result.events?.length ? `<div class="danger-event-list">${result.events.map((event) => `<form class="danger-event-row" data-purge-event="${escapeHtml(event.id)}"><div><span class="event-status ${escapeHtml(event.status.toLowerCase())}">${escapeHtml(statusLabels[event.status])}</span><strong>${escapeHtml(event.name)}</strong><small>${escapeHtml(event.business_date)} ・ 注文 ${escapeHtml(event.order_count || 0)}件</small></div><label>確認入力<input name="confirmation" autocomplete="off" placeholder="DELETE" aria-label="削除確認" required /></label><button class="danger">完全に削除</button><div class="danger-event-message" aria-live="polite"></div></form>`).join("")}</div>` : `<div class="empty compact-empty">削除できる営業日はありません</div>`}`;
    target.querySelectorAll("[data-purge-event]").forEach((form) => {
      form.onsubmit = async (submitEvent) => {
        submitEvent.preventDefault();
        const confirmation = String(new FormData(form).get("confirmation") || "").trim();
        const message = form.querySelector(".danger-event-message");
        if (confirmation !== "DELETE") { message.innerHTML = `<div class="error">確認入力に DELETE と入力してください。</div>`; return; }
        const button = form.querySelector("button");
        button.disabled = true;
        try {
          await api(`/api/admin/events/${encodeURIComponent(form.dataset.purgeEvent)}?force=true`, { method: "DELETE", headers: { Authorization: `Bearer ${token}`, "X-Danger-Confirm": "DELETE-EVENT" } });
          await loadAdminData();
        } catch (error) {
          button.disabled = false;
          message.innerHTML = `<div class="error">削除できません：${escapeHtml(error.message)}</div>`;
        }
      };
    });
  } catch (error) { target.innerHTML = `<div class="error">削除対象を読み込めません：${escapeHtml(error.message)}</div>`; }
}

function openEventEditor(event, token) {
  const modal = document.querySelector("#event-editor-modal");
  modal.innerHTML = `<form class="modal-card" id="event-editor-form"><div class="modal-header"><div><span class="step-label">BUSINESS DAY</span><h2>営業日を編集</h2></div><button type="button" class="modal-close" aria-label="閉じる">×</button></div><label>営業日名<input name="name" value="${escapeHtml(event.name)}" required /></label><label>日付<input name="businessDate" type="date" value="${escapeHtml(event.business_date)}" required /></label><div id="event-editor-message"></div><div class="button-row"><button class="primary">変更を保存</button></div></form>`;
  modal.querySelector(".modal-close").onclick = () => modal.close();
  modal.querySelector("#event-editor-form").onsubmit = async (formEvent) => { formEvent.preventDefault(); const data = Object.fromEntries(new FormData(formEvent.currentTarget)); try { await api(`/api/admin/events/${encodeURIComponent(event.id)}`, { method: "PATCH", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(data) }); modal.close(); await loadEvents(token); } catch (error) { modal.querySelector("#event-editor-message").innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`; } };
  modal.showModal();
}

async function loadSettingsWithToken(token) {
  try {
    const result = await api("/api/admin/order-number-settings", { headers: { Authorization: `Bearer ${token}` } });
    const s = result.settings;
    localStorage.setItem("order-system:number-settings", JSON.stringify({ offlinePrefix: s.offline_prefix, offlineStartNumber: s.offline_start_number }));
    document.querySelector("#settings-form").innerHTML = `<form class="form-grid" id="settings"><label>オンライン開始<input name="onlineStartNumber" type="number" value="${s.online_start_number}" /></label><label>オンライン終了<input name="onlineEndNumber" type="number" value="${s.online_end_number}" /></label><label>オフライン接頭辞<input name="offlinePrefix" value="${s.offline_prefix}" /></label><label>オフライン開始<input name="offlineStartNumber" type="number" value="${s.offline_start_number}" /></label><button class="primary">番号設定を保存</button></form>`;
    document.querySelector("#settings").onsubmit = async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)); const payload = { onlineStartNumber: Number(data.onlineStartNumber), onlineEndNumber: Number(data.onlineEndNumber), offlinePrefix: data.offlinePrefix, offlineStartNumber: Number(data.offlineStartNumber) }; await api("/api/admin/order-number-settings", { method: "PATCH", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) }); localStorage.setItem("order-system:number-settings", JSON.stringify({ offlinePrefix: payload.offlinePrefix, offlineStartNumber: payload.offlineStartNumber })); alert("保存しました"); };
  } catch (error) { document.querySelector("#settings-form").innerHTML = `<div class="error">番号設定を読み込めません：${error.message}</div>`; }
}

function currentRoute() {
  const hashRoute = location.hash.startsWith("#/") ? location.hash.slice(2).split("/")[0] : "";
  if (hashRoute) return hashRoute;
  return location.pathname.replace(/^\/+|\/+$/g, "").split("/")[0] || "";
}

function route() {
  const path = currentRoute();
  if (["reception", "kitchen", "delivery", "display", "admin"].includes(path)) localStorage.setItem("order-system:last-route", path);
  if (path === "reception") reception(); else if (path === "kitchen") kitchen(); else if (path === "delivery") delivery(); else if (path === "display") display(); else if (path === "status") publicOrderStatus(); else if (path === "admin") adminPanel(); else home();
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-route]");
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  const nextRoute = link.dataset.route || "";
  history.pushState({}, "", nextRoute ? `/${nextRoute}` : "/");
  route();
  window.scrollTo({ top: 0, behavior: "instant" });
});

window.addEventListener("hashchange", route);
window.addEventListener("popstate", route);
route();
