/**
 * Slack API client — send messages, upload files, manage threads.
 */

export interface SlackMessage {
  channel: string;
  text: string;
  thread_ts?: string;
  blocks?: unknown[];
}

export class SlackService {
  async joinChannel(botToken: string, channel: string): Promise<void> {
    await fetch("https://slack.com/api/conversations.join", {
      method: "POST",
      headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel }),
    });
  }

  async sendMessage(botToken: string, msg: SlackMessage): Promise<{ ts: string }> {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(msg),
    });
    const data = await res.json() as Record<string, unknown>;
    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error}`);
    }
    return { ts: data.ts as string };
  }

  async updateMessage(botToken: string, channel: string, ts: string, text: string, blocks?: unknown[]): Promise<void> {
    const res = await fetch("https://slack.com/api/chat.update", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel, ts, text, blocks }),
    });
    const data = await res.json() as Record<string, unknown>;
    if (!data.ok) {
      throw new Error(`Slack update error: ${data.error}`);
    }
  }

  async addReaction(botToken: string, channel: string, ts: string, emoji: string): Promise<void> {
    await fetch("https://slack.com/api/reactions.add", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel, timestamp: ts, name: emoji }),
    });
  }

  async removeReaction(botToken: string, channel: string, ts: string, emoji: string): Promise<void> {
    await fetch("https://slack.com/api/reactions.remove", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel, timestamp: ts, name: emoji }),
    });
  }
}
