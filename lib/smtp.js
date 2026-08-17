// Minimal SMTP client (no dependency), ported from Nebula-2's lib/smtp.ts.
const net = require("node:net");
const tls = require("node:tls");
const crypto = require("node:crypto");

function b64(s) { return Buffer.from(s, "utf8").toString("base64"); }
function encodeHeader(s) { return /^[\x20-\x7e]*$/.test(s) ? s : "=?UTF-8?B?" + b64(s) + "?="; }

function conn(sock) {
  let buf = "";
  let waiter = null;
  const complete = () => {
    const m = buf.match(/^(?:\d{3}-[^\r\n]*\r\n)*(\d{3}) [^\r\n]*\r\n/);
    if (m && waiter) { const w = waiter; waiter = null; const out = { code: parseInt(m[1], 10), text: buf }; buf = ""; w.resolve(out); }
  };
  sock.on("data", (d) => { buf += d.toString("utf8"); complete(); });
  sock.on("error", (e) => { if (waiter) { waiter.reject(e); waiter = null; } });
  return {
    read() { return new Promise((resolve, reject) => { waiter = { resolve, reject }; complete(); }); },
    send(line) { sock.write(line + "\r\n"); return this.read(); },
    write(data) { sock.write(data); },
    raw: sock,
  };
}

function expect(r, ok) {
  const list = Array.isArray(ok) ? ok : [ok];
  if (!list.includes(r.code)) throw new Error("SMTP " + r.code + ": " + r.text.trim().slice(0, 140));
}

async function sendMail(cfg, mail) {
  const secure = cfg.secure ?? cfg.port === 465;
  await new Promise((resolve, reject) => {
    const fail = (e) => reject(e);
    const onReady = async (c) => {
      try {
        await c.send("AUTH LOGIN").then((r) => expect(r, 334));
        await c.send(b64(cfg.user)).then((r) => expect(r, 334));
        await c.send(b64(cfg.pass)).then((r) => expect(r, 235));
        const fromAddr = (cfg.from.match(/<([^>]+)>/) ?? [, cfg.from])[1];
        const fromHeader = mail.fromName ? encodeHeader(mail.fromName) + " <" + fromAddr + ">" : cfg.from;
        const domain = (fromAddr.split("@")[1] || "localhost");
        await c.send("MAIL FROM:<" + fromAddr + ">").then((r) => expect(r, 250));
        await c.send("RCPT TO:<" + mail.to + ">").then((r) => expect(r, [250, 251]));
        await c.send("DATA").then((r) => expect(r, 354));
        const stuff = (s) => s.replace(/\r?\n/g, "\r\n").replace(/\r\n\./g, "\r\n..");
        let headers =
          "From: " + fromHeader + "\r\n" +
          "To: " + mail.to + "\r\n" +
          "Reply-To: " + fromHeader + "\r\n" +
          "Subject: " + encodeHeader(mail.subject) + "\r\n" +
          "Message-ID: <" + crypto.randomBytes(16).toString("hex") + "@" + domain + ">\r\n" +
          "Date: " + new Date().toUTCString() + "\r\n" +
          "MIME-Version: 1.0\r\n" +
          "Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n";
        c.write(headers + stuff(mail.html) + "\r\n.\r\n");
        await c.read().then((r) => expect(r, 250));
        c.send("QUIT").catch(() => {});
        try { c.raw.end(); } catch {}
        resolve();
      } catch (e) { try { c.raw.end(); } catch {} reject(e); }
    };

    if (secure) {
      const sock = tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host }, async () => {
        const c = conn(sock);
        try { expect(await c.read(), 220); expect(await c.send("EHLO hallucheck"), 250); await onReady(c); } catch (e) { fail(e); }
      });
      sock.setTimeout(15000, () => { sock.destroy(); fail(new Error("SMTP timeout")); });
      sock.on("error", fail);
    } else {
      const sock = net.connect({ host: cfg.host, port: cfg.port }, async () => {
        const c = conn(sock);
        try {
          expect(await c.read(), 220);
          expect(await c.send("EHLO hallucheck"), 250);
          expect(await c.send("STARTTLS"), 220);
          const tsock = tls.connect({ socket: sock, servername: cfg.host }, async () => {
            const tc = conn(tsock);
            try { expect(await tc.send("EHLO hallucheck"), 250); await onReady(tc); } catch (e) { fail(e); }
          });
          tsock.on("error", fail);
        } catch (e) { fail(e); }
      });
      sock.setTimeout(15000, () => { sock.destroy(); fail(new Error("SMTP timeout")); });
      sock.on("error", fail);
    }
  });
}

function smtpConfigFromEnv() {
  const host = process.env.SMTP_HOST, user = process.env.SMTP_USER, pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || user;
  if (!host || !user || !pass || !from) return null;
  return { host, port: Number(process.env.SMTP_PORT || 587), user, pass, from, secure: process.env.SMTP_SECURE === "true" };
}

module.exports = { sendMail, smtpConfigFromEnv };
