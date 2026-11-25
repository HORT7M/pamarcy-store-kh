import "server-only";
import nodemailer from "nodemailer";
import { isLoopbackHostname, serverEnv } from "@/lib/env";
import { renderSafeEmailHtml, sanitizeHeaderText, safeMailtoHref } from "@/lib/sanitize";

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

export function emailConfigured() {
  return serverEnv.smtp.configured;
}

export type SmtpConfigInput = {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  allowInsecureLocal?: boolean;
  isProduction?: boolean;
};

/**
 * Build a TLS-enforced Nodemailer SMTP transport configuration.
 * - Port 465 uses implicit TLS (`secure: true`).
 * - Port 587 / other ports enforce mandatory STARTTLS (`requireTLS: true`) to prevent MITM downgrade.
 * - Requires TLSv1.2+ and strict certificate verification (`rejectUnauthorized: true`).
 * - Plaintext SMTP is ONLY permitted on loopback hosts in non-production when explicitly enabled.
 */
export function buildSmtpTransportConfig(input: SmtpConfigInput) {
  const implicitTls = input.port === 465;
  const allowPlainLocal =
    !input.isProduction && Boolean(input.allowInsecureLocal) && isLoopbackHostname(input.host);

  return {
    host: input.host,
    port: input.port,
    secure: implicitTls,
    requireTLS: !implicitTls && !allowPlainLocal,
    ignoreTLS: allowPlainLocal,
    tls: {
      minVersion: "TLSv1.2" as const,
      rejectUnauthorized: !allowPlainLocal,
    },
    auth: input.user ? { user: input.user, pass: input.pass ?? "" } : undefined,
  };
}

export async function sendEmail(to: string, subject: string, text: string, html?: string) {
  if (!emailConfigured() || !to) return false;
  const mailto = safeMailtoHref(to);
  if (!mailto) return false;
  const safeTo = mailto.slice("mailto:".length);
  const safeSubject = sanitizeHeaderText(subject, 250);
  if (!safeSubject) return false;

  transporter ??= nodemailer.createTransport(
    buildSmtpTransportConfig({
      host: serverEnv.smtp.host,
      port: serverEnv.smtp.port,
      user: serverEnv.smtp.user || undefined,
      pass: serverEnv.smtp.pass || undefined,
      allowInsecureLocal: serverEnv.smtp.allowInsecureLocal,
      isProduction: serverEnv.isProduction,
    }),
  );
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
