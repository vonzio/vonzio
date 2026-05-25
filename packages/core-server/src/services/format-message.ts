import { Marked } from "marked";
import { slackifyMarkdown } from "slackify-markdown";

const htmlRenderer = new Marked({
  gfm: true,
  breaks: true,
  renderer: { html: () => "" },
});

export function toHtml(markdown: string): string {
  return htmlRenderer.parse(markdown) as string;
}

export function toSlackMrkdwn(markdown: string): string {
  return slackifyMarkdown(markdown).trim();
}

export function toPlainText(markdown: string): string {
  let out = markdown;

  out = out.replace(/```[\s\S]*?```/g, (block) =>
    block.replace(/^```\w*\n?|\n?```$/g, ""),
  );

  out = out.replace(/`([^`]+)`/g, "$1");
  out = out.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  out = out.replace(/^\s{0,3}>\s?/gm, "");
  out = out.replace(/^(\s*)[-*+]\s+/gm, "$1• ");
  out = out.replace(/(\*\*|__)(.+?)\1/g, "$2");
  out = out.replace(/(\*|_)(.+?)\1/g, "$2");
  out = out.replace(/~~(.+?)~~/g, "$1");
  out = out.replace(/\n{3,}/g, "\n\n");

  return out.trim();
}
