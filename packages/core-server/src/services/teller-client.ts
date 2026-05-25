import { readFileSync } from "node:fs";
import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";
import type { Config } from "../config.js";

export interface TellerAccount {
  id: string;
  name: string;
  type: string;
  subtype: string;
  status: string;
  currency: string;
  last_four?: string;
  institution: { id: string; name: string };
  enrollment_id: string;
}

export interface TellerBalance {
  account_id: string;
  available: string;
  ledger: string;
}

export interface TellerTransaction {
  id: string;
  account_id: string;
  date: string;
  description: string;
  amount: string;
  type: string;
  status: string;
  running_balance?: string | null;
  details?: {
    category?: string | null;
    counterparty?: { name?: string; type?: string };
  };
}

export interface TellerAccountDetails {
  account_id: string;
  account_number?: string;
  routing_numbers?: { ach?: string; wire?: string };
}

export class TellerNotConfiguredError extends Error {
  constructor() {
    super("Teller is not configured (TELLER_CERT_PATH/TELLER_KEY_PATH missing)");
    this.name = "TellerNotConfiguredError";
  }
}

export class TellerApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`Teller API error (${status}): ${body.slice(0, 500)}`);
    this.name = "TellerApiError";
    this.status = status;
    this.body = body;
  }
}

export class TellerClient {
  private dispatcher: UndiciAgent | null = null;
  private dispatcherError: Error | null = null;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  isConfigured(): boolean {
    return Boolean(this.config.TELLER_CERT_PATH && this.config.TELLER_KEY_PATH);
  }

  private getDispatcher(): UndiciAgent {
    if (this.dispatcherError) throw this.dispatcherError;
    if (this.dispatcher) return this.dispatcher;
    if (!this.isConfigured()) throw new TellerNotConfiguredError();
    try {
      const cert = readFileSync(this.config.TELLER_CERT_PATH!);
      const key = readFileSync(this.config.TELLER_KEY_PATH!);
      // undici routes the cert/key into the TLS connect options for every
      // request through this dispatcher. Node's built-in fetch ignores the
      // legacy `agent` option, so we have to go through `dispatcher`.
      this.dispatcher = new UndiciAgent({ connect: { cert, key } });
      return this.dispatcher;
    } catch (err) {
      this.dispatcherError = err instanceof Error ? err : new Error(String(err));
      throw this.dispatcherError;
    }
  }

  private async request<T>(accessToken: string, path: string): Promise<T> {
    const url = `${this.config.TELLER_API_BASE.replace(/\/$/, "")}${path}`;
    const basicAuth = Buffer.from(`${accessToken}:`).toString("base64");
    // Use undici's fetch (not Node's built-in) so the dispatcher we pass is
    // ABI-matched. Node ships its own pinned undici internally, which
    // rejects an Agent constructed from a different undici major.
    const res = await undiciFetch(url, {
      dispatcher: this.getDispatcher(),
      headers: {
        Authorization: `Basic ${basicAuth}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new TellerApiError(res.status, body);
    }
    return (await res.json()) as T;
  }

  listAccounts(accessToken: string): Promise<TellerAccount[]> {
    return this.request<TellerAccount[]>(accessToken, "/accounts");
  }

  getBalance(accessToken: string, accountId: string): Promise<TellerBalance> {
    return this.request<TellerBalance>(accessToken, `/accounts/${encodeURIComponent(accountId)}/balances`);
  }

  listTransactions(accessToken: string, accountId: string, opts?: { count?: number; fromId?: string }): Promise<TellerTransaction[]> {
    const params = new URLSearchParams();
    if (opts?.count) params.set("count", String(opts.count));
    if (opts?.fromId) params.set("from_id", opts.fromId);
    const qs = params.toString();
    const path = `/accounts/${encodeURIComponent(accountId)}/transactions${qs ? `?${qs}` : ""}`;
    return this.request<TellerTransaction[]>(accessToken, path);
  }

  getAccountDetails(accessToken: string, accountId: string): Promise<TellerAccountDetails> {
    return this.request<TellerAccountDetails>(accessToken, `/accounts/${encodeURIComponent(accountId)}/details`);
  }
}
