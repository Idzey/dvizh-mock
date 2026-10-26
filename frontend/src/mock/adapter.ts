// Axios-адаптер: вместо сети отвечает ядро мока. Подключается в authMutator только при VITE_MOCK.
import { AxiosError, CanceledError, type AxiosResponse, type InternalAxiosRequestConfig } from "axios";
import { dispatch } from "./core";
import { currentSessionUserId, setSessionUserId } from "./db";

const sleep = (ms: number, signal?: AbortSignal | null) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new CanceledError("canceled"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new CanceledError("canceled"));
      },
      { once: true },
    );
  });

/** Читающие запросы быстрее записывающих: скелетоны видны, но лента не тормозит. */
const latency = (method: string) => (method === "GET" ? 50 + Math.random() * 100 : 150 + Math.random() * 250);

function parseBody(data: unknown): unknown {
  if (typeof data !== "string") return data ?? null;
  if (data === "") return null;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

export async function mockAdapter(config: InternalAxiosRequestConfig): Promise<AxiosResponse> {
  const method = (config.method ?? "get").toUpperCase();
  const signal = config.signal as AbortSignal | undefined;
  let url = config.url ?? "/";
  if (config.params) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(config.params as Record<string, unknown>)) {
      if (value !== undefined && value !== null) search.append(key, String(value));
    }
    if (search.size) url += (url.includes("?") ? "&" : "?") + search.toString();
  }

  const started = performance.now();
  const result = await dispatch({ method, url, body: parseBody(config.data), userId: currentSessionUserId() });
  if (result.userId !== undefined) setSessionUserId(result.userId);
  await sleep(Math.max(0, latency(method) - (performance.now() - started)), signal);

  const response: AxiosResponse = {
    data: result.text,
    status: result.status,
    statusText: "",
    headers: { "content-type": result.contentType },
    config,
    request: {},
  };
  if (result.status >= 200 && result.status < 300) return response;
  throw new AxiosError(
    `Request failed with status code ${result.status}`,
    result.status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
    config,
    {},
    response,
  );
}
