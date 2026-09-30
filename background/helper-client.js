const HELPER_BASE_URL = "http://127.0.0.1:17385";

export async function helperRequest(method, path, payload, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${HELPER_BASE_URL}${path}`, {
      method,
      headers: payload === undefined ? {} : { "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: controller.signal,
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok || !value.ok) {
      const error = new Error(value.error || `Media Helper HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return value.data ?? {};
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Media Helper 응답 시간이 초과되었습니다.");
    if (error instanceof TypeError) {
      throw new Error("Media Helper에 연결할 수 없습니다. start.ps1을 실행해 주세요.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function probeHelper() {
  return helperRequest("GET", "/hello", undefined, 10000);
}
