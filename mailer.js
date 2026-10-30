// Sends email through an SMTP server (Gmail by default) with no extra packages.
//
// Railway variables:
//   SMTP_USER  the Gmail account that sends (e.g. wfmhelp2026@gmail.com)
//   SMTP_PASS  that account's 16-character Google app password
//   MAIL_FROM  the address people see (defaults to SUPPORT_EMAIL); must be a
//              verified "Send mail as" address on that Gmail account
//   SMTP_HOST / SMTP_PORT  optional, default smtp.gmail.com:465 (TLS)
// If SMTP_USER or SMTP_PASS is missing, email is turned off and nothing is sent.

const tls = require("tls");
const net = require("net");
const crypto = require("crypto");

const cfg = () => ({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: Number(process.env.SMTP_PORT || 465),
  user: process.env.SMTP_USER || "",
  pass: (process.env.SMTP_PASS || "").replace(/\s+/g, ""), // app passwords are often pasted with spaces
  from: process.env.MAIL_FROM || process.env.SUPPORT_EMAIL || process.env.SMTP_USER || "",
  insecure: process.env.SMTP_INSECURE === "1", // tests only: plain TCP to a local fake server
});

const enabled = () => {
  const c = cfg();
  return !!(c.user && c.pass && c.from);
};

const clean = (s) => String(s).replace(/[\r\n]+/g, " ").trim();
const addr = (s) => {
  const a = clean(s);
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(a)) throw new Error("Bad email address");
  return a;
};
// Wraps long lines so no line passes SMTP's 998-character limit, and escapes leading dots.
const body = (s) =>
  String(s)
    .replace(/\r?\n/g, "\r\n")
    .split("\r\n")
    .flatMap((line) => (line.length > 900 ? line.match(/.{1,900}/g) : [line]))
    .map((line) => (line.startsWith(".") ? "." + line : line))
    .join("\r\n");

function build({ fromName, from, to, subject, text, html }) {
  const boundary = "wfm-" + crypto.randomBytes(12).toString("hex");
  const domain = from.split("@")[1];
  const headers = [
    `From: ${fromName ? `"${clean(fromName).replace(/"/g, "")}" ` : ""}<${from}>`,
    `To: <${to}>`,
    `Subject: ${clean(subject)}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const parts = [
    `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", body(text),
    `--${boundary}`, "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", body(html),
    `--${boundary}--`,
  ];
  return headers.join("\r\n") + "\r\n\r\n" + parts.join("\r\n");
}

// One SMTP conversation: connect, log in, send, quit.
function sendMail({ to, subject, text, html, fromName = "Wait For Me!" }) {
  const c = cfg();
  if (!enabled()) return Promise.resolve({ sent: false, reason: "Email is not set up." });
  const rcpt = addr(to);
  const from = addr(c.from);
  const message = build({ fromName, from, to: rcpt, subject, text, html });
  const steps = [
    [null, 220],
    [`EHLO ${from.split("@")[1]}`, 250],
    ["AUTH LOGIN", 334],
    [Buffer.from(c.user).toString("base64"), 334],
    [Buffer.from(c.pass).toString("base64"), 235],
    [`MAIL FROM:<${from}>`, 250],
    [`RCPT TO:<${rcpt}>`, 250],
    ["DATA", 354],
    [message + "\r\n.", 250],
    ["QUIT", 221],
  ];

  return new Promise((resolve, reject) => {
    const sock = c.insecure ? net.connect(c.port, c.host) : tls.connect({ host: c.host, port: c.port, servername: c.host });
    let buf = "";
    let i = 0;
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      err ? reject(err) : resolve({ sent: true });
    };
    const timer = setTimeout(() => finish(new Error("Email server timed out")), 20000);
    sock.setEncoding("utf8");
    sock.on("error", finish);
    sock.on("close", () => finish(i >= steps.length - 1 ? null : new Error("Email server closed the connection")));
    sock.on("data", (chunk) => {
      buf += chunk;
      // A reply is complete when a line has a space after its 3-digit code ("250 OK", not "250-...").
      const lines = buf.split("\r\n");
      const last = lines.findIndex((l) => /^\d{3} /.test(l));
      if (last < 0) return;
      const lastLine = lines[last];
      buf = lines.slice(last + 1).join("\r\n");
      const code = Number(lastLine.slice(0, 3));
      const want = steps[i][1];
      if (code !== want) {
        const what = i === 4 ? "Email login failed (check SMTP_USER and SMTP_PASS)" : `Email server said: ${lastLine}`;
        return finish(new Error(what));
      }
      i++;
      if (i >= steps.length) return finish(null);
      sock.write(steps[i][0] + "\r\n");
    });
  });
}

module.exports = { sendMail, mailEnabled: enabled };
