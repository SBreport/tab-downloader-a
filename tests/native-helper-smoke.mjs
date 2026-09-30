const baseUrl = "http://127.0.0.1:17385";
const origin = "chrome-extension://nccjgbgpcokjhaalfdbfmkomielehekd";

async function request(method, path, payload, timeoutMs = 120000) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Origin: origin,
      ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const value = await response.json();
  if (!response.ok || !value.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value.data;
}

const hello = await request("GET", "/hello", undefined, 10000);
if (hello.version !== "0.11.0") throw new Error(`Helper 버전이 0.11.0이 아닙니다: ${hello.version}`);
console.log("Helper hello:", hello);

const formatRejected = await fetch(`${baseUrl}/start-images`, {
  method: "POST",
  headers: { Origin: origin, "Content-Type": "application/json" },
  body: JSON.stringify({
    jobId: `format-security-smoke-${Date.now()}`,
    root: "Security Smoke",
    title: "Rejected",
    type: "twitter",
    imageFormat: "jpeg",
    assets: [{
      url: "https://pbs.twimg.com/media/fixture?format=png&name=orig",
      filename: "0001.png",
      referer: "https://x.com/example/status/123",
    }],
  }),
});
const formatRejectedBody = await formatRejected.json();
if (formatRejected.ok || formatRejectedBody.ok) throw new Error("Helper가 허용되지 않은 이미지 출력 형식을 거부하지 않았습니다.");
console.log("Helper image format: rejected unsupported output");

const rejected = await fetch(`${baseUrl}/start-images`, {
  method: "POST",
  headers: { Origin: origin, "Content-Type": "application/json" },
  body: JSON.stringify({
    jobId: `security-smoke-${Date.now()}`,
    root: "Security Smoke",
    title: "Rejected",
    type: "twitter",
    assets: [{ url: "https://example.com/external.jpg", filename: "0001.jpg", referer: "https://x.com/example/status/123" }],
  }),
});
const rejectedBody = await rejected.json();
if (rejected.ok || rejectedBody.ok) throw new Error("Helper가 허용되지 않은 이미지 호스트를 거부하지 않았습니다.");
console.log("Helper image allowlist: rejected external host");

const probeUrl = process.argv[2];
if (probeUrl) {
  const probe = await request("POST", "/probe", { url: probeUrl, referer: process.argv[3] });
  console.log("Media probe:", probe);
}
