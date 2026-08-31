import { readdir } from "node:fs/promises";

const args = process.argv.slice(2);
const baseUrlIndex = args.indexOf("--base-url");
const rawBaseUrl = baseUrlIndex >= 0 ? args[baseUrlIndex + 1] : process.env.SMOKE_BASE_URL;
const baseUrl = new URL(rawBaseUrl || "http://127.0.0.1:8787");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, init) {
  return fetch(new URL(path, baseUrl), { redirect: "follow", ...init });
}

async function checkHtmlRoute(path) {
  const response = await request(path);
  assert(response.status === 200, `${path}: expected 200, received ${response.status}`);
  assert(response.headers.get("content-type")?.includes("text/html"), `${path}: HTML content type is missing`);
  assert(response.headers.get("content-security-policy")?.includes("default-src 'self'"), `${path}: CSP is missing`);
  assert(response.headers.get("x-content-type-options") === "nosniff", `${path}: X-Content-Type-Options is missing`);
  assert(response.headers.get("x-frame-options") === "DENY", `${path}: X-Frame-Options is missing`);
  assert(response.headers.get("referrer-policy") === "no-referrer", `${path}: Referrer-Policy is missing`);
  assert(response.headers.get("permissions-policy")?.includes("camera=()"), `${path}: Permissions-Policy is missing`);
  const html = await response.text();
  assert(html.includes("注文受付システム"), `${path}: application shell was not returned`);
}

async function checkUnauthorized(path, init) {
  const response = await request(path, init);
  assert(response.status === 401, `${path}: expected unauthenticated 401, received ${response.status}`);
}

async function main() {
  const migrationVersions = (await readdir(new URL("../migrations/", import.meta.url)))
    .map((name) => Number(name.match(/^(\d+)_.*\.sql$/)?.[1]))
    .filter(Number.isFinite);
  const expectedSchemaVersion = Math.max(...migrationVersions);
  const healthResponse = await request("/health");
  assert(healthResponse.status === 200, `/health: expected 200, received ${healthResponse.status}`);
  const health = await healthResponse.json();
  assert(
    health.ok === true && health.database === "ready" && health.schemaVersion === expectedSchemaVersion,
    `/health: expected ready schema ${expectedSchemaVersion}, received ${health.schemaVersion ?? "unknown"}`,
  );
  assert(healthResponse.headers.get("cache-control") === "no-store", "/health: no-store is missing");

  for (const path of ["/", "/reception", "/kitchen", "/delivery", "/display", "/admin"]) {
    await checkHtmlRoute(path);
  }

  await checkUnauthorized("/api/delivery/ready");
  await checkUnauthorized("/api/admin/orders");
  await checkUnauthorized("/api/kitchen/next", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventId: "smoke", deviceId: "smoke", operationId: "smoke" }),
  });

  console.log(`Smoke check passed: ${baseUrl.origin}`);
}

main().catch((error) => {
  console.error(`Smoke check failed: ${error.message}`);
  process.exitCode = 1;
});
