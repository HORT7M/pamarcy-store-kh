import "server-only";
import nodemailer from "nodemailer";
import { serverEnv } from "@/lib/env";
import { renderSafeEmailHtml, sanitizeHeaderText, safeMailtoHref } from "@/lib/sanitize";

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

export function emailConfigured() {
  return serverEnv.smtp.configured;
}

export async function sendEmail(to: string, subject: string, text: string, html?: string) {
  if (!emailConfigured() || !to) return false;
  const mailto = safeMailtoHref(to);
  if (!mailto) return false;
  const safeTo = mailto.slice("mailto:".length);
  const safeSubject = sanitizeHeaderText(subject, 250);
  if (!safeSubject) return false;

  transporter ??= nodemailer.createTransport({
    host: serverEnv.smtp.host,
    port: serverEnv.smtp.port,
    secure: serverEnv.smtp.port === 465,
    auth: serverEnv.smtp.user ? { user: serverEnv.smtp.user, pass: serverEnv.smtp.pass } : undefined,
  });
  try {
    await transporter.sendMail({ from: serverEnv.smtp.from, to: safeTo, subject: safeSubject, text, html });
    return true;
  } catch (e) {
    console.error("[email]", e);
    return false;
  }
}

/**
 * Send a transactional notification email with both plain-text and properly context-escaped HTML
 * body (all dynamic text is HTML-escaped and URLs are protocol-validated while preserving line breaks).
 */
export async function sendSafeHtmlEmail(
  to: string,
  subject: string,
  opts: { title: string; message: string; linkUrl?: string | null; linkLabel?: string; footer?: string },
) {
  const html = renderSafeEmailHtml(opts);
  const text = opts.linkUrl ? `${opts.message}\n\n${opts.linkUrl}` : opts.message;
  return sendEmail(to, subject, text, html);
}
