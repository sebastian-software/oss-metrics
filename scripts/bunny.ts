/**
 * A minimal client for the Bunny REST API (https://api.bunny.net), shared by
 * the rollout scripts. It never logs request bodies — they carry secrets.
 */

export type BunnyApi = <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>;

export class BunnyError extends Error {
  readonly status: number;
  readonly path: string;
  readonly detail: string;

  constructor(status: number, path: string, detail: string) {
    super(`Bunny API ${path} answered ${status}: ${detail}`);
    this.status = status;
    this.path = path;
    this.detail = detail;
  }
}

/** Reads a required environment variable, failing with a message that names it. */
export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function bunnyApi(apiKey: string, base = "https://api.bunny.net"): BunnyApi {
  return async <T>(method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        AccessKey: apiKey,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      // Bunny answers errors as { ErrorKey, Field, Message }; keep only the message.
      let detail = text.slice(0, 300);
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === "object" && parsed !== null && "Message" in parsed) {
          detail = String(parsed.Message);
        }
      } catch {
        // Not JSON: the raw text is the detail.
      }
      throw new BunnyError(response.status, path, detail);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  };
}

/** Appends `key=value` lines to the step outputs when running in GitHub Actions. */
export async function setOutputs(outputs: Record<string, string>) {
  const file = process.env.GITHUB_OUTPUT;
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
  if (file) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(file, `${lines.join("\n")}\n`);
  }
  for (const line of lines) console.log(`output ${line}`);
}
